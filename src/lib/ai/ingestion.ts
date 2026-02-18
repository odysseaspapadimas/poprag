import { eq } from "drizzle-orm";
import { ulid } from "ulidx";
import { db } from "@/db";
import {
  documentChunks,
  type InsertKnowledgeSource,
  knowledgeSource,
} from "@/db/schema";
import { DEFAULT_MODELS } from "@/lib/ai/constants";
import { generateChunks, generateEmbeddings } from "@/lib/ai/embedding";

/**
 * Utility to split an array into chunks of specified size
 */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

const VECTORIZE_DELETE_BATCH_SIZE = 100;
const D1_INSERT_BATCH_SIZE = 10; // D1 has ~100 param limit; 10 chunks * 7 fields = 70 params
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 400;

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("terminated") ||
    message.includes("abort") ||
    message.includes("aborted") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("socket")
  );
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const abortError = new Error("Request aborted");
    abortError.name = "AbortError";
    throw abortError;
  }
}

async function withRetry<T>(
  operation: () => Promise<T>,
  options?: {
    retries?: number;
    baseDelayMs?: number;
    label?: string;
    abortSignal?: AbortSignal;
  },
): Promise<T> {
  const retries = options?.retries ?? DEFAULT_RETRY_ATTEMPTS;
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;

  for (let attempt = 0; attempt <= retries; attempt++) {
    assertNotAborted(options?.abortSignal);

    try {
      return await operation();
    } catch (error) {
      if (!isRetryableError(error) || attempt >= retries) {
        throw error;
      }

      const backoff =
        baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 100);
      console.warn(
        `[Ingestion] ${options?.label ?? "operation"} failed (attempt ${
          attempt + 1
        }/${retries + 1}). Retrying in ${backoff}ms...`,
        error,
      );
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }

  throw new Error("Retry attempts exhausted");
}

export async function deleteVectorizeIds(
  vectorize: {
    deleteByIds: (ids: string[]) => Promise<{ mutationId: string }>;
  },
  ids: string[],
  options?: {
    namespace?: string;
    logPrefix?: string;
  },
): Promise<void> {
  const batches = chunkArray(ids, VECTORIZE_DELETE_BATCH_SIZE);
  // Run deletion batches concurrently - they are independent operations
  await Promise.all(
    batches.map(async (batch, i) => {
      if (batch.length === 0) return;

      const deleteResult = await vectorize.deleteByIds(batch);
      console.log(
        `${options?.logPrefix ?? "Vectorize"} deleted batch ${i + 1}/${batches.length} (${batch.length} ids)` +
          (options?.namespace ? ` in namespace ${options.namespace}` : "") +
          `, mutationId: ${deleteResult.mutationId}`,
      );
    }),
  );
}

/**
 * Stream response callback type for progress updates
 */
export type StreamResponseCallback = (message: {
  message?: string;
  progress?: number;
  error?: string;
  [key: string]: unknown;
}) => Promise<void>;

/**
 * Wait for a Vectorize mutation to be processed
 */
export async function waitForMutation(
  vectorize: any,
  mutationId: string,
  maxWaitMs: number = 30000,
  pollIntervalMs: number = 1000,
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const status = await vectorize.describe();
      if (status.processedUpToMutation >= parseInt(mutationId)) {
        console.log(`Mutation ${mutationId} processed successfully`);
        return;
      }
    } catch (error) {
      console.warn(`Error checking mutation status: ${error}`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Mutation ${mutationId} did not complete within ${maxWaitMs}ms`,
  );
}
export async function checkMutationStatus(
  vectorize: any,
  mutationId: string,
): Promise<boolean> {
  try {
    const status = await vectorize.describe();
    return status.processedUpToMutation >= parseInt(mutationId);
  } catch (error) {
    console.error(`Error checking mutation status: ${error}`);
    return false;
  }
}

export interface ParsedDocument {
  content: string;
  metadata: Record<string, unknown>;
  chunks?: Array<{
    text: string;
    metadata: Record<string, unknown>;
  }>;
}

/**
 * Parse text content from uploaded file
 * Handles plain text, markdown, and various document formats using Cloudflare's toMarkdown service
 */
export async function parseDocument(
  content: string | Buffer | Uint8Array,
  mimeType: string,
  filename?: string,
): Promise<ParsedDocument> {
  // Convert buffer to string for text-based formats
  const text =
    typeof content === "string" ? content : content.toString("utf-8");

  // Handle markdown files
  if (
    mimeType === "text/markdown" ||
    filename?.endsWith(".md") ||
    filename?.endsWith(".markdown")
  ) {
    return {
      content: text,
      metadata: { mimeType, type: "markdown", originalLength: text.length },
    };
  }

  // Handle plain text
  if (mimeType.startsWith("text/") && mimeType !== "text/csv") {
    return {
      content: text,
      metadata: { mimeType, type: "text", originalLength: text.length },
    };
  }

  // For binary formats supported by toMarkdown, use Cloudflare's toMarkdown service
  const supportedMimeTypes = [
    // PDF
    "application/pdf",
    // Images
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/svg+xml",
    // HTML
    "text/html",
    // XML
    "application/xml",
    // Microsoft Office
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel.sheet.macroenabled.12",
    "application/vnd.ms-excel.sheet.binary.macroenabled.12",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    // Open Document Format
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/vnd.oasis.opendocument.text",
    // CSV
    "text/csv",
    // Apple Documents
    "application/vnd.apple.numbers",
  ];

  const supportedExtensions = [
    // PDF
    ".pdf",
    // Images
    ".jpeg",
    ".jpg",
    ".png",
    ".webp",
    ".svg",
    // HTML
    ".html",
    // XML
    ".xml",
    // Microsoft Office
    ".xlsx",
    ".xlsm",
    ".xlsb",
    ".xls",
    ".et",
    ".docx",
    // Open Document Format
    ".ods",
    ".odt",
    // CSV
    ".csv",
    // Apple Documents
    ".numbers",
  ];

  const isSupportedFormat =
    supportedMimeTypes.includes(mimeType) ||
    (filename &&
      supportedExtensions.some((ext) => filename.toLowerCase().endsWith(ext)));

  if (isSupportedFormat && typeof content !== "string") {
    try {
      const { env } = await import("cloudflare:workers");
      // Convert to proper Uint8Array for Blob creation
      const uint8Array = Buffer.isBuffer(content)
        ? new Uint8Array(
            content.buffer.slice(
              content.byteOffset,
              content.byteOffset + content.byteLength,
            ),
          )
        : content;
      const blob = new Blob([uint8Array as any], { type: mimeType });
      const file = { name: filename || "document", blob };

      const result = await env.AI.toMarkdown(file);

      if (result.format === "markdown") {
        return {
          content: result.data,
          metadata: {
            mimeType,
            type: "markdown",
            originalLength: result.data.length,
            tokens: result.tokens,
          },
        };
      } else {
        throw new Error(`toMarkdown failed: ${result.error}`);
      }
    } catch (error) {
      throw new Error(
        `Failed to convert document to markdown: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // For unsupported formats, treat as text
  return {
    content: text,
    metadata: { mimeType, type: "text", originalLength: text.length },
  };
}

/**
 * Process and index a knowledge source with streaming updates
 * Full pipeline: parse → chunk → embed → store in Vectorize and D1
 */
export async function processKnowledgeSource(
  sourceId: string,
  content: string | Buffer | Uint8Array,
  options?: {
    chunkSize?: number;
    streamResponse?: StreamResponseCallback;
    abortSignal?: AbortSignal;
  },
) {
  // Get source from database
  const [source] = await db
    .select()
    .from(knowledgeSource)
    .where(eq(knowledgeSource.id, sourceId))
    .limit(1);

  if (!source) {
    throw new Error(`Knowledge source ${sourceId} not found`);
  }

  // Platform-wide embedding model - no per-agent override
  const embeddingModel = DEFAULT_MODELS.EMBEDDING;

  const streamResponse = options?.streamResponse || (async () => {});
  const abortSignal = options?.abortSignal;

  try {
    // Update status to parsing
    await db
      .update(knowledgeSource)
      .set({ status: "parsed", updatedAt: new Date() })
      .where(eq(knowledgeSource.id, sourceId));

    assertNotAborted(abortSignal);
    // Parse document
    const parsed = await parseDocument(
      content,
      source.mime || "text/plain",
      source.fileName || undefined,
    );
    await streamResponse({
      message: "Document parsed successfully",
      metadata: parsed.metadata,
    });

    const contentType =
      parsed.metadata.type === "markdown" ? "markdown" : "text";

    assertNotAborted(abortSignal);
    const chunks = await generateChunks(parsed.content, {
      chunkSize: options?.chunkSize || 1024,
      chunkOverlap: 200,
      minChunkSize: 100,
      contentType,
    });
    await streamResponse({ message: `Split into ${chunks.length} chunks` });

    console.log(`Generated ${chunks.length} chunks for source ${sourceId}`);

    // Process chunks in batches for embedding
    const BATCH_SIZE = 50; // Reduced batch size for better progress tracking
    const chunkBatches = chunkArray(chunks, BATCH_SIZE);
    const vectorizeIds: string[] = [];
    const { env } = await import("cloudflare:workers");
    let processedChunks = 0;

    // Process each batch
    for (let batchIdx = 0; batchIdx < chunkBatches.length; batchIdx++) {
      const batch = chunkBatches[batchIdx];
      assertNotAborted(abortSignal);

      // Generate embeddings for this batch using platform-wide model
      const startTime = Date.now();
      const embeddingBatch: number[][] = await withRetry(
        () =>
          generateEmbeddings(batch, {
            model: embeddingModel,
            abortSignal,
          }),
        {
          label: `embedding batch ${batchIdx + 1}`,
          abortSignal,
        },
      );
      const embeddingTime = Date.now() - startTime;

      console.log(
        `Batch ${batchIdx + 1} embedding took ${embeddingTime}ms for ${batch.length} chunks`,
      );

      // Insert chunks into database in smaller batches to respect D1 parameter limits
      // D1 has a limit of ~100 parameters per query
      // With 7 fields per chunk, we can safely insert 10 chunks at a time (70 params)
      const chunkInsertData = batch.map((chunk, idx) => {
        const chunkId = ulid();
        return {
          id: chunkId,
          text: chunk,
          sessionId: source.agentId,
          documentId: source.id,
          chunkIndex: processedChunks + idx,
          vectorizeId: chunkId, // Set vectorizeId to the chunk ID (used as vector ID)
          createdAt: new Date(),
        };
      });

      const d1Batches = chunkArray(chunkInsertData, D1_INSERT_BATCH_SIZE);

      // Run D1 sub-batch inserts concurrently (they are independent writes)
      const d1InsertResults = await Promise.all(
        d1Batches.map((d1Batch) =>
          db
            .insert(documentChunks)
            .values(d1Batch)
            .returning({ insertedChunkId: documentChunks.id }),
        ),
      );
      const chunkIds = d1InsertResults.flatMap((r) =>
        r.map((row) => row.insertedChunkId),
      );

      vectorizeIds.push(...chunkIds);

      // Insert vectors into VECTORIZE_INDEX with lightweight metadata only
      // Full chunk text is stored in D1 (documentChunks table) and fetched during retrieval
      // by enrichWithFullText() — keeping Vectorize metadata small avoids the 3KB limit
      // and removes the artificial chunk size ceiling
      const vectorizeStartTime = Date.now();
      await withRetry(
        () =>
          env.VECTORIZE.insert(
            embeddingBatch.map((embedding, index) => ({
              id: chunkIds[index],
              values: embedding,
              namespace: source.agentId, // Use agentId for namespace isolation
              metadata: {
                sourceId: source.id,
                chunkId: chunkIds[index],
                fileName: source.fileName || "Unknown source",
              },
            })),
          ),
        {
          label: `vectorize insert batch ${batchIdx + 1}`,
          abortSignal,
        },
      );
      const vectorizeTime = Date.now() - vectorizeStartTime;

      console.log(
        `Batch ${batchIdx + 1} vectorize insert took ${vectorizeTime}ms`,
      );

      processedChunks += batch.length;
      const progressPercent = ((batchIdx + 1) / chunkBatches.length) * 100;
      await streamResponse({
        message: `Embedding... (${progressPercent.toFixed(1)}%)`,
        progress: progressPercent,
      });

      console.log(
        `Processed batch ${batchIdx + 1}/${chunkBatches.length}, embedded ${processedChunks} chunks`,
      );
    }

    // Store vectorize IDs and mark as indexed in a single update
    await db
      .update(knowledgeSource)
      .set({
        vectorizeIds: vectorizeIds,
        status: "indexed",
        updatedAt: new Date(),
      })
      .where(eq(knowledgeSource.id, sourceId));

    await streamResponse({
      message: "Inserted vectors into database",
      chunksProcessed: processedChunks,
      vectorsInserted: vectorizeIds.length,
    });

    return {
      success: true,
      vectorsInserted: vectorizeIds.length,
      chunksProcessed: processedChunks,
    };
  } catch (error) {
    // Log detailed error for debugging
    console.error("Indexing failed - detailed error:", {
      error: error,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      sourceId,
      agentId: source?.agentId,
    });

    // Update status to failed
    await db
      .update(knowledgeSource)
      .set({
        status: "failed",
        parserErrors: [error instanceof Error ? error.message : String(error)],
        updatedAt: new Date(),
      })
      .where(eq(knowledgeSource.id, sourceId));

    await streamResponse({
      error: error instanceof Error ? error.message : String(error),
    });

    throw error;
  }
}

/**
 * Create knowledge source record
 */
export async function createKnowledgeSource(
  data: Omit<InsertKnowledgeSource, "createdAt" | "updatedAt">,
): Promise<string> {
  const id = data.id || ulid();
  await db.insert(knowledgeSource).values({
    ...data,
    id,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

/**
 * Delete knowledge source from DB, R2, and Vectorize
 */
export async function deleteKnowledgeSource(sourceId: string): Promise<void> {
  // Get source to access R2 key and agent ID
  const [source] = await db
    .select()
    .from(knowledgeSource)
    .where(eq(knowledgeSource.id, sourceId))
    .limit(1);

  if (!source) {
    throw new Error(`Knowledge source ${sourceId} not found`);
  }

  // Delete from Vectorize using stored vectorizeIds
  if (source.vectorizeIds && source.vectorizeIds.length > 0) {
    const { env } = await import("cloudflare:workers");
    try {
      // Delete vectors from agent's namespace
      await deleteVectorizeIds(env.VECTORIZE, source.vectorizeIds, {
        namespace: source.agentId,
        logPrefix: "Vectorize",
      });
    } catch (error) {
      console.error("Failed to delete vectors from Vectorize:", error);
      // Continue with deletion even if Vectorize fails
    }
  }

  // Delete from R2
  if (source.r2Key) {
    try {
      const { env } = await import("cloudflare:workers");
      await env.R2.delete(source.r2Key);
      console.log(`Deleted R2 object: ${source.r2Key}`);
    } catch (error) {
      console.error("Failed to delete from R2:", error);
      // Continue with deletion even if R2 fails
    }
  }

  // Delete from database
  await db.delete(knowledgeSource).where(eq(knowledgeSource.id, sourceId));
}

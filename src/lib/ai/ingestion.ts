import { db } from "@/db";
import {
	documentChunks,
	type InsertKnowledgeSource,
	knowledgeSource,
} from "@/db/schema";
import type { TextSplitter } from "@langchain/textsplitters";
import {
	MarkdownTextSplitter,
	RecursiveCharacterTextSplitter,
} from "@langchain/textsplitters";
import { eq } from "drizzle-orm";
import { ulid } from "ulidx";
import { extractText, getDocumentProxy } from "unpdf";

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
 * Handles plain text, markdown, and PDF files
 */
export async function parseDocument(
  content: string | Buffer,
  mimeType: string,
  filename?: string,
): Promise<ParsedDocument> {
  // Handle PDF files
  if (mimeType === "application/pdf") {
    if (typeof content === "string") {
      throw new Error("PDF content must be a Buffer");
    }
    try {
      const buffer = content as Buffer;
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const result = await extractText(pdf, { mergePages: true });
      const text = Array.isArray(result.text)
        ? result.text.join(" ")
        : result.text;

      return {
        content: text,
        metadata: {
          mimeType,
          type: "pdf",
          originalLength: text.length,
        },
      };
    } catch (error) {
      throw new Error(
        `Failed to parse PDF: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

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
  if (mimeType.startsWith("text/")) {
    return {
      content: text,
      metadata: { mimeType, type: "text", originalLength: text.length },
    };
  }

  // For Excel/CSV files
  if (
    mimeType.includes("spreadsheet") ||
    mimeType.includes("csv") ||
    mimeType.includes("excel")
  ) {
    // For now, treat as text
    // In production, use a library like xlsx or csv-parse for better parsing
    return {
      content: text,
      metadata: { mimeType, type: "spreadsheet", originalLength: text.length },
    };
  }

  throw new Error(`Unsupported file type: ${mimeType}`);
}

/**
 * Process and index a knowledge source with streaming updates
 * Full pipeline: parse → chunk → embed (batch) → store in Vectorize and D1
 */
export async function processKnowledgeSource(
  sourceId: string,
  content: string | Buffer,
  options?: {
    embeddingModel?: string;
    embeddingDimensions?: number;
    chunkSize?: number;
    streamResponse?: StreamResponseCallback;
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

  const streamResponse = options?.streamResponse || (async () => {});

  try {
    // Update status to parsing
    await db
      .update(knowledgeSource)
      .set({ status: "parsed", updatedAt: new Date() })
      .where(eq(knowledgeSource.id, sourceId));

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

    // Choose appropriate text splitter based on file type
    let splitter: TextSplitter;
    if (parsed.metadata.type === "markdown") {
      // Use MarkdownTextSplitter for markdown files to preserve structure
      splitter = new MarkdownTextSplitter({
        chunkSize: options?.chunkSize || 1024,
        chunkOverlap: 200,
      });
      console.log(`Using MarkdownTextSplitter for ${source.fileName}`);
    } else {
      // Use RecursiveCharacterTextSplitter for all other file types
      splitter = new RecursiveCharacterTextSplitter({
        chunkSize: options?.chunkSize || 1024,
        chunkOverlap: 200,
      });
      console.log(
        `Using RecursiveCharacterTextSplitter for ${source.fileName}`,
      );
    }

    const chunks = await splitter.splitText(parsed.content);
    await streamResponse({ message: `Split into ${chunks.length} chunks` });

    console.log(`Generated ${chunks.length} chunks for source ${sourceId}`);

    // Process chunks in batches for embedding
    const BATCH_SIZE = 5; // Reduced batch size for better progress tracking
    const chunkBatches = chunkArray(chunks, BATCH_SIZE);
    const vectorizeIds: string[] = [];
    const { env } = await import("cloudflare:workers");
    let processedChunks = 0;

    // Process each batch
    for (let batchIdx = 0; batchIdx < chunkBatches.length; batchIdx++) {
      const batch = chunkBatches[batchIdx];

      // Generate embeddings for this batch using Workers AI BGE model
      const startTime = Date.now();
      const embeddingResult: { data: number[][] } = (await env.AI.run(
        "@cf/baai/bge-large-en-v1.5",
        {
          text: batch,
        },
      )) as { data: number[][] };
      const embeddingBatch: number[][] = embeddingResult.data;
      const embeddingTime = Date.now() - startTime;

      console.log(`Batch ${batchIdx + 1} embedding took ${embeddingTime}ms for ${batch.length} chunks`);

      // Insert chunks into database FIRST to get the IDs
      const chunkInsertResults = await db
        .insert(documentChunks)
        .values(
          batch.map((chunk, idx) => ({
            id: ulid(),
            text: chunk,
            sessionId: source.agentId,
            documentId: source.id,
            chunkIndex: processedChunks + idx,
            createdAt: new Date(),
          })),
        )
        .returning({ insertedChunkId: documentChunks.id });

      // Extract the inserted chunk IDs
      const chunkIds = chunkInsertResults.map(
        (result) => result.insertedChunkId,
      );
      vectorizeIds.push(...chunkIds);

      // Insert vectors into VECTORIZE_INDEX with proper metadata
      const vectorizeStartTime = Date.now();
      await env.VECTORIZE.insert(
        embeddingBatch.map((embedding, index) => ({
          id: chunkIds[index],
          values: embedding,
          namespace: source.agentId, // Use agentId for namespace isolation
          metadata: {
            sessionId: source.agentId,
            documentId: source.id,
            chunkId: chunkIds[index],
            text: batch[index],
          },
        })),
      );
      const vectorizeTime = Date.now() - vectorizeStartTime;

      console.log(`Batch ${batchIdx + 1} vectorize insert took ${vectorizeTime}ms`);

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

    // Store vectorize IDs for deletion tracking
    await db
      .update(knowledgeSource)
      .set({
        vectorizeIds: vectorizeIds,
        updatedAt: new Date(),
      })
      .where(eq(knowledgeSource.id, sourceId));

    // Update source status
    await db
      .update(knowledgeSource)
      .set({
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
      const deleteResult = await env.VECTORIZE.deleteByIds(source.vectorizeIds);
      console.log(
        `Initiated deletion of ${source.vectorizeIds.length} vectors from Vectorize namespace: ${source.agentId}, mutationId: ${deleteResult.mutationId}`,
      );
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

import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
  documentChunks,
  type KnowledgeSource,
  knowledgeSource,
} from "@/db/schema";
import {
  deleteVectorizeIds,
  isResourceExhaustionError,
  isRetryableIngestionError,
  normalizeKnowledgeIngestionError,
  processKnowledgeSource,
} from "@/lib/ai/ingestion";

const MAX_QUEUE_RETRIES = 3;
const RETRY_DELAY_SECONDS = [10, 30, 90] as const;
const FALLBACK_REDUCED_CHUNK_SIZE = 768;
const FALLBACK_EMBEDDING_BATCH_SIZE = 8;
const QUEUE_INDEXING_TIME_SLICE_MS = 8 * 60 * 1000;

function getQueueRetryDelaySeconds(attempt: number): number {
  return RETRY_DELAY_SECONDS[Math.max(0, attempt - 1)] ?? 180;
}

function getRetrySettings(attempt: number): {
  chunkSize?: number;
  embeddingBatchSize?: number;
  reason?: string;
} {
  if (attempt <= 1) {
    return {};
  }

  return {
    chunkSize: FALLBACK_REDUCED_CHUNK_SIZE,
    embeddingBatchSize: FALLBACK_EMBEDDING_BATCH_SIZE,
    reason:
      attempt === 2
        ? "Retrying with smaller chunks"
        : "Retrying with smaller chunks and smaller embedding batches",
  };
}

/**
 * Message schema for the knowledge indexing queue
 */
export interface KnowledgeIndexMessage {
  sourceId: string;
  agentId: string;
  resume?: boolean;
  startChunkIndex?: number;
  chunkSize?: number;
  embeddingBatchSize?: number;
}

async function getIndexedChunkState(sourceId: string): Promise<{
  chunkCount: number;
  nextChunkIndex: number;
}> {
  const rows = await db
    .select({ chunkIndex: documentChunks.chunkIndex })
    .from(documentChunks)
    .where(eq(documentChunks.documentId, sourceId));

  const maxChunkIndex = rows.reduce(
    (max, row) => Math.max(max, row.chunkIndex),
    -1,
  );

  return {
    chunkCount: rows.length,
    nextChunkIndex: maxChunkIndex + 1,
  };
}

async function cleanupSourceIndexData(
  source: KnowledgeSource,
  env: Env,
): Promise<void> {
  const chunkRows = await db
    .select({ vectorizeId: documentChunks.vectorizeId })
    .from(documentChunks)
    .where(eq(documentChunks.documentId, source.id));

  const vectorIds = Array.from(
    new Set(
      [
        ...(source.vectorizeIds ?? []),
        ...chunkRows
          .map((row) => row.vectorizeId)
          .filter((value): value is string => Boolean(value)),
      ].filter(Boolean),
    ),
  );

  if (vectorIds.length > 0) {
    try {
      await deleteVectorizeIds(env.VECTORIZE, vectorIds, {
        namespace: source.agentId,
        logPrefix: "Vectorize",
      });
    } catch (deleteError) {
      console.error(
        `[Queue] Failed deleting vectors for source ${source.id}; continuing cleanup:`,
        deleteError,
      );
    }
  }

  await db
    .delete(documentChunks)
    .where(eq(documentChunks.documentId, source.id));
}

/**
 * Handle a batch of knowledge indexing messages from Cloudflare Queues.
 *
 * Each message triggers:
 * 1. Fetch the file from R2
 * 2. Run the full ingestion pipeline (parse -> chunk -> embed -> vectorize)
 * 3. Write progress updates back to D1 so the UI can poll for status
 *
 * Messages are ack'd on success and retried on failure.
 */
export async function handleKnowledgeIndexQueue(
  batch: MessageBatch<KnowledgeIndexMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    const { sourceId } = message.body;
    const isContinuation = message.body.resume === true;
    const attempt = Math.max(message.attempts, 1);
    const retryCount = Math.max(attempt - 1, 0);
    const hasMoreQueueRetries = retryCount < MAX_QUEUE_RETRIES;
    const retrySettings = isContinuation
      ? {
          chunkSize: message.body.chunkSize,
          embeddingBatchSize: message.body.embeddingBatchSize,
        }
      : getRetrySettings(attempt);
    let source: KnowledgeSource | undefined;

    try {
      // Fetch source metadata from D1
      [source] = await db
        .select()
        .from(knowledgeSource)
        .where(eq(knowledgeSource.id, sourceId))
        .limit(1);

      if (!source) {
        console.error(
          `[Queue] Source ${sourceId} not found in database, acking to prevent retry`,
        );
        message.ack();
        continue;
      }

      if (
        isContinuation &&
        (source.status === "indexed" || source.status === "failed")
      ) {
        console.log(
          `[Queue] Source ${sourceId} is already ${source.status}; acking stale continuation`,
        );
        message.ack();
        continue;
      }

      if (!source.r2Key) {
        console.error(
          `[Queue] Source ${sourceId} has no R2 key, marking as failed`,
        );
        await db
          .update(knowledgeSource)
          .set({
            status: "failed",
            parserErrors: ["No R2 file found for this source"],
            updatedAt: new Date(),
          })
          .where(eq(knowledgeSource.id, sourceId));
        message.ack();
        continue;
      }

      // Fetch file from R2
      const r2Object = await env.R2.get(source.r2Key);
      if (!r2Object) {
        console.error(
          `[Queue] R2 object not found for source ${sourceId} (key: ${source.r2Key})`,
        );
        await db
          .update(knowledgeSource)
          .set({
            status: "failed",
            parserErrors: ["File not found in R2 storage"],
            updatedAt: new Date(),
          })
          .where(eq(knowledgeSource.id, sourceId));
        message.ack();
        continue;
      }

      // Pass ArrayBuffer directly — avoid Buffer.from() copy to reduce memory usage.
      // Workers have a 128MB limit; for a 20MB file, each extra copy is significant.
      const content = await r2Object.arrayBuffer();

      console.log(
        `[Queue] Processing source ${sourceId} (${source.fileName}, ${content.byteLength} bytes)` +
          (isContinuation ? " as continuation" : ""),
      );

      if (!isContinuation) {
        await cleanupSourceIndexData(source, env);
      }

      const indexedChunkState = isContinuation
        ? await getIndexedChunkState(sourceId)
        : { chunkCount: 0, nextChunkIndex: 0 };

      await db
        .update(knowledgeSource)
        .set({
          status: "processing",
          progress: isContinuation ? source.progress : 0,
          progressMessage:
            isContinuation && indexedChunkState.nextChunkIndex > 0
              ? `Continuing background indexing from chunk ${indexedChunkState.nextChunkIndex}`
              : (retrySettings.reason ??
                (retryCount > 0
                  ? `Retry ${retryCount}/${MAX_QUEUE_RETRIES}: resuming indexing`
                  : "Queued for background indexing")),
          vectorizeIds: isContinuation ? source.vectorizeIds : [],
          parserErrors: [],
          retryCount,
          updatedAt: new Date(),
        })
        .where(eq(knowledgeSource.id, sourceId));

      // Run the full ingestion pipeline with progress updates written to D1
      const result = await processKnowledgeSource(sourceId, content, {
        chunkSize: retrySettings.chunkSize,
        embeddingBatchSize: retrySettings.embeddingBatchSize,
        retryCount,
        resumeFromChunkIndex: indexedChunkState.nextChunkIndex,
        maxRuntimeMs: QUEUE_INDEXING_TIME_SLICE_MS,
        persistFailureState: false,
      });

      if (!result.completed) {
        const nextChunkIndex = result.nextChunkIndex ?? result.chunksProcessed;
        const queue = env.KNOWLEDGE_INDEX_QUEUE as Queue<KnowledgeIndexMessage>;
        await queue.send({
          sourceId,
          agentId: source.agentId,
          resume: true,
          startChunkIndex: nextChunkIndex,
          chunkSize: retrySettings.chunkSize,
          embeddingBatchSize: retrySettings.embeddingBatchSize,
        });
        console.log(
          `[Queue] Paused source ${sourceId} at chunk ${nextChunkIndex}/${result.totalChunks}; continuation queued`,
        );
        message.ack();
        continue;
      }

      console.log(`[Queue] Successfully indexed source ${sourceId}`);
      message.ack();
    } catch (error) {
      console.error(`[Queue] Failed to process source ${sourceId}:`, error);
      const normalizedError = normalizeKnowledgeIngestionError(error);
      const shouldRetry =
        hasMoreQueueRetries && isRetryableIngestionError(error);
      const scheduledRetryNumber = retryCount + 1;
      // Update status in D1 before retrying/failing out
      try {
        await db
          .update(knowledgeSource)
          .set({
            status: shouldRetry ? "processing" : "failed",
            progressMessage: shouldRetry
              ? isResourceExhaustionError(error)
                ? `Retry ${scheduledRetryNumber}/${MAX_QUEUE_RETRIES} scheduled after resource pressure`
                : `Retry ${scheduledRetryNumber}/${MAX_QUEUE_RETRIES} scheduled after transient failure`
              : normalizedError,
            parserErrors: shouldRetry ? [] : [normalizedError],
            retryCount: shouldRetry ? scheduledRetryNumber : retryCount,
            updatedAt: new Date(),
          })
          .where(eq(knowledgeSource.id, sourceId));
      } catch (dbError) {
        console.error(
          `[Queue] Failed to update status for source ${sourceId}:`,
          dbError,
        );
      }

      if (shouldRetry) {
        const delaySeconds = getQueueRetryDelaySeconds(attempt);
        message.retry({ delaySeconds });
        continue;
      }

      if (source) {
        try {
          await cleanupSourceIndexData(source, env);
        } catch (cleanupError) {
          console.error(
            `[Queue] Failed cleaning up permanently failed source ${sourceId}:`,
            cleanupError,
          );
        }
      }

      message.ack();
    }
  }
}

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { documentChunks, knowledgeSource } from "@/db/schema";
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
    const attempt = Math.max(message.attempts, 1);
    const retryCount = Math.max(attempt - 1, 0);
    const hasMoreQueueRetries = retryCount < MAX_QUEUE_RETRIES;
    const retrySettings = getRetrySettings(attempt);

    try {
      // Fetch source metadata from D1
      const [source] = await db
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
        `[Queue] Processing source ${sourceId} (${source.fileName}, ${content.byteLength} bytes)`,
      );

      // Best effort cleanup before indexing to keep queue retries/idempotency safe.
      // This prevents duplicate chunks/vectors when a message is retried.
      try {
        const chunkRows = await db
          .select({ vectorizeId: documentChunks.vectorizeId })
          .from(documentChunks)
          .where(eq(documentChunks.documentId, sourceId));
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
          await deleteVectorizeIds(env.VECTORIZE, vectorIds, {
            namespace: source.agentId,
            logPrefix: "Vectorize",
          });
        }
      } catch (deleteError) {
        console.error(
          `[Queue] Failed deleting old vectors for source ${sourceId}:`,
          deleteError,
        );
      }

      await db
        .delete(documentChunks)
        .where(eq(documentChunks.documentId, sourceId));

      await db
        .update(knowledgeSource)
        .set({
          status: "processing",
          progress: 0,
          progressMessage:
            retrySettings.reason ??
            (retryCount > 0
              ? `Retry ${retryCount}/${MAX_QUEUE_RETRIES}: resuming indexing`
              : "Queued for background indexing"),
          vectorizeIds: [],
          parserErrors: [],
          retryCount,
          updatedAt: new Date(),
        })
        .where(eq(knowledgeSource.id, sourceId));

      // Run the full ingestion pipeline with progress updates written to D1
      await processKnowledgeSource(sourceId, content, {
        chunkSize: retrySettings.chunkSize,
        embeddingBatchSize: retrySettings.embeddingBatchSize,
        retryCount,
        persistFailureState: false,
      });

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

      message.ack();
    }
  }
}

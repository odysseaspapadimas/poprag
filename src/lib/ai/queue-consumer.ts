import { eq } from "drizzle-orm";
import { db } from "@/db";
import { knowledgeSource } from "@/db/schema";
import { processKnowledgeSource } from "@/lib/ai/ingestion";

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

      // Run the full ingestion pipeline with progress updates written to D1
      await processKnowledgeSource(sourceId, content, {
        streamResponse: async ({ progress }) => {
          if (progress != null) {
            await db
              .update(knowledgeSource)
              .set({
                progress: Math.round(progress),
                updatedAt: new Date(),
              })
              .where(eq(knowledgeSource.id, sourceId));
          }
        },
      });

      console.log(`[Queue] Successfully indexed source ${sourceId}`);
      message.ack();
    } catch (error) {
      console.error(`[Queue] Failed to process source ${sourceId}:`, error);

      // Update status to failed in D1
      try {
        await db
          .update(knowledgeSource)
          .set({
            status: "failed",
            parserErrors: [
              error instanceof Error ? error.message : String(error),
            ],
            updatedAt: new Date(),
          })
          .where(eq(knowledgeSource.id, sourceId));
      } catch (dbError) {
        console.error(
          `[Queue] Failed to update status for source ${sourceId}:`,
          dbError,
        );
      }

      // Retry the message (Cloudflare Queues handles backoff)
      message.retry();
    }
  }
}

import { AwsClient } from "aws4fetch";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "@/db";
import { knowledgeSource } from "@/db/schema";
import { audit, requireAgent } from "@/integrations/trpc/helpers";
import { createTRPCRouter, protectedProcedure } from "@/integrations/trpc/init";
import { generateEmbedding } from "@/lib/ai/embedding";
import {
  createKnowledgeSource,
  deleteKnowledgeSource,
  processKnowledgeSource,
} from "@/lib/ai/ingestion";

/**
 * Knowledge management router
 */
export const knowledgeRouter = createTRPCRouter({
  /**
   * Initiate file upload
   * Returns upload configuration for client-side upload
   */
  uploadStart: protectedProcedure
    .input(
      z.object({
        agentId: z.string(),
        fileName: z.string(),
        mime: z.string(),
        bytes: z.number(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // Verify agent exists
      await requireAgent(input.agentId);

      // Create knowledge source record with agent-scoped R2 key
      const sourceId = nanoid();
      const r2Key = `agents/${input.agentId}/sources/${sourceId}/${input.fileName}`;

      await createKnowledgeSource({
        id: sourceId,
        agentId: input.agentId,
        type: "r2-file",
        fileName: input.fileName,
        mime: input.mime,
        bytes: input.bytes,
        status: "uploaded", // Will be set to "uploaded" again after confirm, or "failed" on error
        r2Bucket: "poprag", // Match wrangler.jsonc bucket name
        r2Key,
      });

      // Generate R2 presigned URL for direct upload
      const { env } = await import("cloudflare:workers");

      // Create AWS4 client for R2 with credentials from environment
      const aws = new AwsClient({
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      });

      // Build the R2 URL following Cloudflare's format: https://{bucket}.{accountId}.r2.cloudflarestorage.com/{key}
      const url = new URL(
        `https://poprag.${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${r2Key}`,
      );

      // Set expiry in search params (as per Cloudflare docs)
      url.searchParams.set("X-Amz-Expires", "3600"); // 1 hour

      // Create the request to sign
      // Important: When using signQuery, do NOT include headers in the signed request
      // The headers must be sent by the client but are not part of the signature
      const request = new Request(url, {
        method: "PUT",
      });

      // Sign the request with query parameters (generates presigned URL)
      const signedRequest = await aws.sign(request, {
        aws: { signQuery: true },
      });

      const uploadUrl = signedRequest.url;

      return {
        sourceId,
        uploadUrl,
        uploadMethod: "presigned",
      };
    }),

  /**
   * Confirm upload and trigger processing
   */
  confirm: protectedProcedure
    .input(
      z.object({
        sourceId: z.string(),
        checksum: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const [source] = await db
        .select()
        .from(knowledgeSource)
        .where(eq(knowledgeSource.id, input.sourceId))
        .limit(1);

      if (!source) {
        throw new Error("Source not found");
      }

      // Update status to uploaded and checksum if provided
      await db
        .update(knowledgeSource)
        .set({
          status: "uploaded",
          checksum: input.checksum,
          updatedAt: new Date(),
        })
        .where(eq(knowledgeSource.id, input.sourceId));

      // Audit log
      await audit(
        ctx,
        "knowledge.uploaded",
        { type: "knowledge_source", id: input.sourceId },
        {
          fileName: source.fileName,
        },
      );

      return { success: true };
    }),

  /**
   * Mark upload as failed
   */
  markFailed: protectedProcedure
    .input(
      z.object({
        sourceId: z.string(),
        error: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const [source] = await db
        .select()
        .from(knowledgeSource)
        .where(eq(knowledgeSource.id, input.sourceId))
        .limit(1);

      if (!source) {
        throw new Error("Source not found");
      }

      // Update status to failed
      await db
        .update(knowledgeSource)
        .set({
          status: "failed",
          parserErrors: input.error ? [input.error] : [],
          updatedAt: new Date(),
        })
        .where(eq(knowledgeSource.id, input.sourceId));

      // Audit log
      await audit(
        ctx,
        "knowledge.failed",
        { type: "knowledge_source", id: input.sourceId },
        {
          error: input.error,
        },
      );

      return { success: true };
    }),

  /**
   * Index knowledge source (parse + embed + vectorize)
   * Optimized to avoid R2 round-trip for small files
   */
  index: protectedProcedure
    .input(
      z.object({
        sourceId: z.string(),
        reindex: z.boolean().default(false),
        // Optional: pass content directly to avoid R2 download
        content: z.string().optional(),
        contentBuffer: z.instanceof(Uint8Array).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const [source] = await db
        .select()
        .from(knowledgeSource)
        .where(eq(knowledgeSource.id, input.sourceId))
        .limit(1);

      if (!source) {
        throw new Error("Source not found");
      }

      // Verify user has access to the agent
      await requireAgent(source.agentId);

      // Get content - either from input or from R2
      let content: string | Buffer | Uint8Array;
      if (input.content) {
        content = input.content;
      } else if (input.contentBuffer) {
        content = input.contentBuffer;
      } else {
        // Fallback: fetch from R2
        const { env } = await import("cloudflare:workers");
        const r2Object = await env.R2.get(source.r2Key!);
        if (!r2Object) {
          throw new Error("File not found in storage");
        }

        // Get content based on file type - PDFs need Buffer, others can be text
        if (source.mime === "application/pdf") {
          const arrayBuffer = await r2Object.arrayBuffer();
          content = Buffer.from(arrayBuffer);
        } else {
          content = await r2Object.text();
        }
      }

      try {
        const result = await processKnowledgeSource(input.sourceId, content, {
          abortSignal: ctx.request.signal,
        });

        // Update source status to indexed
        await db
          .update(knowledgeSource)
          .set({
            status: "indexed",
            updatedAt: new Date(),
          })
          .where(eq(knowledgeSource.id, input.sourceId));

        // Audit log
        await audit(
          ctx,
          "knowledge.indexed",
          { type: "knowledge_source", id: input.sourceId },
          {
            vectorsInserted: result.vectorsInserted,
            reindex: input.reindex,
          },
        );

        return result;
      } catch (error) {
        // Update status to failed
        await db
          .update(knowledgeSource)
          .set({
            status: "failed",
            updatedAt: new Date(),
          })
          .where(eq(knowledgeSource.id, input.sourceId));

        throw new Error(
          `Indexing failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }),

  /**
   * Get knowledge source status
   */
  status: protectedProcedure
    .input(z.object({ sourceId: z.string() }))
    .query(async ({ input }) => {
      const [source] = await db
        .select()
        .from(knowledgeSource)
        .where(eq(knowledgeSource.id, input.sourceId))
        .limit(1);

      if (!source) {
        throw new Error("Source not found");
      }

      return source;
    }),

  /**
   * Query vectors for similarity search (agent-scoped)
   */
  query: protectedProcedure
    .input(
      z.object({
        agentId: z.string(),
        query: z.string(),
        topK: z.number().default(5),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // Verify agent exists
      const agentData = await requireAgent(input.agentId);

      // Generate embedding for the query
      const queryEmbedding = await generateEmbedding(input.query);

      // Query Vectorize with agent namespace
      const { env } = await import("cloudflare:workers");
      const results = await env.VECTORIZE.query(queryEmbedding, {
        topK: input.topK,
        namespace: input.agentId,
        returnMetadata: true,
      });

      return {
        matches: results.matches.map((match) => ({
          id: match.id,
          score: match.score,
          text: match.metadata?.text as string,
          fileName: match.metadata?.fileName as string,
          sourceId: match.metadata?.sourceId as string,
        })),
      };
    }),

  /**
   * List knowledge sources for an agent
   */
  list: protectedProcedure
    .input(
      z.object({
        agentId: z.string(),
        status: z.enum(["uploaded", "parsed", "indexed", "failed"]).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      // Verify agent exists
      await requireAgent(input.agentId);

      // Build query with optional status filter
      const whereConditions = input.status
        ? and(
            eq(knowledgeSource.agentId, input.agentId),
            eq(knowledgeSource.status, input.status),
          )
        : eq(knowledgeSource.agentId, input.agentId);

      const sources = await db
        .select()
        .from(knowledgeSource)
        .where(whereConditions);

      return sources;
    }),

  /**
   * Reindex knowledge source with updated chunking strategy
   */
  reindex: protectedProcedure
    .input(z.object({ sourceId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const [source] = await db
        .select()
        .from(knowledgeSource)
        .where(eq(knowledgeSource.id, input.sourceId))
        .limit(1);

      if (!source) {
        throw new Error("Source not found");
      }

      // Verify user has access to the agent
      await requireAgent(source.agentId);

      // Check if source has R2 file
      if (!source.r2Key) {
        throw new Error("No R2 file found for this source");
      }

      try {
        // Download the file from R2
        const { env } = await import("cloudflare:workers");
        const r2Object = await env.R2.get(source.r2Key);

        if (!r2Object) {
          throw new Error("File not found in R2");
        }

        // Get content based on file type - PDFs need Buffer, others can be text
        let content: string | Buffer | Uint8Array;
        if (source.mime === "application/pdf") {
          const arrayBuffer = await r2Object.arrayBuffer();
          content = Buffer.from(arrayBuffer);
        } else {
          content = await r2Object.text();
        }

        // Delete old vectors from Vectorize if they exist
        if (source.vectorizeIds && source.vectorizeIds.length > 0) {
          try {
            const { deleteVectorizeIds } = await import("@/lib/ai/ingestion");
            await deleteVectorizeIds(env.VECTORIZE, source.vectorizeIds, {
              namespace: source.agentId,
              logPrefix: "Vectorize",
            });
          } catch (error) {
            console.error("Failed to delete old vectors:", error);
            // Continue anyway - will create duplicates but at least new chunks will be there
          }
        }

        // Reset status and clear old vectorize IDs before reprocessing
        await db
          .update(knowledgeSource)
          .set({
            status: "uploaded",
            vectorizeIds: [],
            updatedAt: new Date(),
          })
          .where(eq(knowledgeSource.id, input.sourceId));

        // Reprocess with new chunking strategy
        await processKnowledgeSource(input.sourceId, content, {
          abortSignal: ctx.request.signal,
        });

        // Audit log
        await audit(
          ctx,
          "knowledge.reindexed",
          { type: "knowledge_source", id: input.sourceId },
          {
            fileName: source.fileName,
          },
        );

        return { success: true };
      } catch (error) {
        console.error("Reindex failed:", error);
        throw new Error(
          `Reindex failed: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
        );
      }
    }),

  /**
   * Delete knowledge source
   */
  delete: protectedProcedure
    .input(z.object({ sourceId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const [source] = await db
        .select()
        .from(knowledgeSource)
        .where(eq(knowledgeSource.id, input.sourceId))
        .limit(1);

      if (!source) {
        throw new Error("Source not found");
      }

      // Verify user has access to the agent
      await requireAgent(source.agentId);

      await deleteKnowledgeSource(input.sourceId);

      // Audit log
      await audit(
        ctx,
        "knowledge.deleted",
        { type: "knowledge_source", id: input.sourceId },
        {
          fileName: source.fileName,
        },
      );

      return { success: true };
    }),

  /**
   * Get presigned download URL for a knowledge source
   */
  getDownloadUrl: protectedProcedure
    .input(z.object({ sourceId: z.string() }))
    .query(async ({ input, ctx }) => {
      const [source] = await db
        .select()
        .from(knowledgeSource)
        .where(eq(knowledgeSource.id, input.sourceId))
        .limit(1);

      if (!source) {
        throw new Error("Source not found");
      }

      // Verify user has access to the agent
      await requireAgent(source.agentId);

      if (!source.r2Key) {
        throw new Error("No R2 file found for this source");
      }

      // Generate R2 presigned URL for download
      const { env } = await import("cloudflare:workers");

      // Create AWS4 client for R2 with credentials from environment
      const aws = new AwsClient({
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      });

      // Build the R2 URL following Cloudflare's format: https://{bucket}.{accountId}.r2.cloudflarestorage.com/{key}
      const url = new URL(
        `https://poprag.${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${source.r2Key}`,
      );

      // Set expiry in search params (24 hours for viewing)
      url.searchParams.set("X-Amz-Expires", "86400");

      // Create the request to sign
      const request = new Request(url, {
        method: "GET",
      });

      // Sign the request with query parameters (generates presigned URL)
      const signedRequest = await aws.sign(request, {
        aws: { signQuery: true },
      });

      return {
        downloadUrl: signedRequest.url,
        fileName: source.fileName,
        mime: source.mime,
      };
    }),
});

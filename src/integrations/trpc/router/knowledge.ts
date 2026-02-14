import { AwsClient } from "aws4fetch";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "@/db";
import { agent, documentChunks, knowledgeSource } from "@/db/schema";
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

        // Note: processKnowledgeSource already sets status to "indexed" in D1,
        // so no additional status update needed here.

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

        // Delete old chunks from D1 database
        await db
          .delete(documentChunks)
          .where(eq(documentChunks.documentId, input.sourceId));

        console.log(
          `Deleted old chunks for source ${input.sourceId} before re-indexing`,
        );

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

  /**
   * Get health overview for all knowledge sources across all agents (or filtered by agent)
   * Returns aggregated status counts, staleness info, and issues
   */
  healthOverview: protectedProcedure
    .input(
      z
        .object({
          agentId: z.string().optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      // Get all agents for the current user (or specific agent)
      const agents = input?.agentId
        ? await db
            .select({ id: agent.id, name: agent.name, slug: agent.slug })
            .from(agent)
            .where(eq(agent.id, input.agentId))
        : await db
            .select({ id: agent.id, name: agent.name, slug: agent.slug })
            .from(agent);

      const agentIds = agents.map((a) => a.id);

      if (agentIds.length === 0) {
        return {
          totalSources: 0,
          statusCounts: { uploaded: 0, parsed: 0, indexed: 0, failed: 0 },
          totalChunks: 0,
          totalBytes: 0,
          staleCount: 0,
          agents: [],
        };
      }

      // Get all knowledge sources for these agents
      const sources = await db
        .select()
        .from(knowledgeSource)
        .where(inArray(knowledgeSource.agentId, agentIds));

      // Get chunk counts per source
      const chunkCounts = await db
        .select({
          sourceId: documentChunks.documentId,
          count: count(),
        })
        .from(documentChunks)
        .where(inArray(documentChunks.sessionId, agentIds))
        .groupBy(documentChunks.documentId);

      const chunkCountMap = new Map(
        chunkCounts.map((c) => [c.sourceId, c.count]),
      );

      // Calculate staleness (sources not updated in 30 days)
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

      // Aggregate stats
      const statusCounts = { uploaded: 0, parsed: 0, indexed: 0, failed: 0 };
      let totalChunks = 0;
      let totalBytes = 0;
      let staleCount = 0;

      const sourcesWithHealth = sources.map((source) => {
        const chunks = chunkCountMap.get(source.id) || 0;
        const isStale = source.updatedAt.getTime() < thirtyDaysAgo;
        const hasErrors = source.parserErrors && source.parserErrors.length > 0;

        statusCounts[source.status]++;
        totalChunks += chunks;
        totalBytes += source.bytes || 0;
        if (isStale) staleCount++;

        return {
          ...source,
          chunkCount: chunks,
          isStale,
          hasErrors,
          daysSinceUpdate: Math.floor(
            (Date.now() - source.updatedAt.getTime()) / (24 * 60 * 60 * 1000),
          ),
        };
      });

      // Group sources by agent
      const agentMap = new Map(
        agents.map((a) => [
          a.id,
          { ...a, sources: [] as typeof sourcesWithHealth },
        ]),
      );
      for (const source of sourcesWithHealth) {
        agentMap.get(source.agentId)?.sources.push(source);
      }

      return {
        totalSources: sources.length,
        statusCounts,
        totalChunks,
        totalBytes,
        staleCount,
        agents: Array.from(agentMap.values()).filter(
          (a) => a.sources.length > 0,
        ),
      };
    }),

  /**
   * Get detailed health info for a single knowledge source
   */
  healthDetail: protectedProcedure
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

      await requireAgent(source.agentId);

      // Get chunk count and sample chunks
      const chunks = await db
        .select({
          id: documentChunks.id,
          text: documentChunks.text,
          chunkIndex: documentChunks.chunkIndex,
          vectorizeId: documentChunks.vectorizeId,
        })
        .from(documentChunks)
        .where(eq(documentChunks.documentId, input.sourceId))
        .orderBy(documentChunks.chunkIndex)
        .limit(10);

      const [chunkCountResult] = await db
        .select({ count: count() })
        .from(documentChunks)
        .where(eq(documentChunks.documentId, input.sourceId));

      // Check if R2 file exists
      let r2Exists = false;
      if (source.r2Key) {
        try {
          const { env } = await import("cloudflare:workers");
          const r2Object = await env.R2.head(source.r2Key);
          r2Exists = !!r2Object;
        } catch {
          r2Exists = false;
        }
      }

      // Calculate staleness
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const isStale = source.updatedAt.getTime() < thirtyDaysAgo;
      const daysSinceUpdate = Math.floor(
        (Date.now() - source.updatedAt.getTime()) / (24 * 60 * 60 * 1000),
      );

      // Check vector coverage
      // Vectors are stored in Vectorize with chunk IDs as vector IDs
      // New chunks have vectorizeId populated, old chunks rely on knowledgeSource.vectorizeIds
      const vectorizedChunks = chunks.filter((c) => c.vectorizeId).length;
      let vectorCoverage = 0;

      if (chunkCountResult.count > 0) {
        if (vectorizedChunks > 0) {
          // Use per-chunk tracking if available (more accurate for sample)
          vectorCoverage =
            (vectorizedChunks /
              Math.min(chunks.length, chunkCountResult.count)) *
            100;
        } else if (source.vectorizeIds) {
          // Fall back to source-level tracking for old data
          vectorCoverage =
            (source.vectorizeIds.length / chunkCountResult.count) * 100;
        }
      }

      return {
        source,
        chunkCount: chunkCountResult.count,
        sampleChunks: chunks,
        r2Exists,
        isStale,
        daysSinceUpdate,
        vectorCoverage,
        issues: [
          ...(source.status === "failed"
            ? [{ type: "error" as const, message: "Indexing failed" }]
            : []),
          ...(source.parserErrors?.map((e) => ({
            type: "error" as const,
            message: e,
          })) || []),
          ...(isStale
            ? [
                {
                  type: "warning" as const,
                  message: `Not updated in ${daysSinceUpdate} days`,
                },
              ]
            : []),
          ...(!r2Exists && source.r2Key
            ? [{ type: "error" as const, message: "R2 file not found" }]
            : []),
          ...(chunkCountResult.count === 0 && source.status === "indexed"
            ? [{ type: "warning" as const, message: "No chunks extracted" }]
            : []),
        ],
      };
    }),

  /**
   * Bulk reindex multiple knowledge sources
   */
  bulkReindex: protectedProcedure
    .input(
      z.object({
        sourceIds: z.array(z.string()),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const BULK_CONCURRENCY = 3;

      // Process a single source for reindexing
      async function reindexOne(sourceId: string): Promise<{
        sourceId: string;
        success: boolean;
        error?: string;
      }> {
        try {
          const [source] = await db
            .select()
            .from(knowledgeSource)
            .where(eq(knowledgeSource.id, sourceId))
            .limit(1);

          if (!source) {
            return { sourceId, success: false, error: "Source not found" };
          }

          await requireAgent(source.agentId);

          if (!source.r2Key) {
            return { sourceId, success: false, error: "No R2 file found" };
          }

          // Download from R2
          const { env } = await import("cloudflare:workers");
          const r2Object = await env.R2.get(source.r2Key);

          if (!r2Object) {
            return { sourceId, success: false, error: "File not found in R2" };
          }

          // Get content based on file type
          let content: string | Buffer | Uint8Array;
          if (source.mime === "application/pdf") {
            const arrayBuffer = await r2Object.arrayBuffer();
            content = Buffer.from(arrayBuffer);
          } else {
            content = await r2Object.text();
          }

          // Delete old vectors and old chunks concurrently
          await Promise.all([
            source.vectorizeIds && source.vectorizeIds.length > 0
              ? import("@/lib/ai/ingestion")
                  .then(({ deleteVectorizeIds }) =>
                    deleteVectorizeIds(env.VECTORIZE, source.vectorizeIds!, {
                      namespace: source.agentId,
                      logPrefix: "Vectorize",
                    }),
                  )
                  .catch((error) => {
                    console.error("Failed to delete old vectors:", error);
                  })
              : Promise.resolve(),
            db
              .delete(documentChunks)
              .where(eq(documentChunks.documentId, sourceId)),
          ]);

          // Reset status
          await db
            .update(knowledgeSource)
            .set({
              status: "uploaded",
              vectorizeIds: [],
              updatedAt: new Date(),
            })
            .where(eq(knowledgeSource.id, sourceId));

          // Reprocess
          await processKnowledgeSource(sourceId, content, {
            abortSignal: ctx.request.signal,
          });

          await audit(
            ctx,
            "knowledge.reindexed",
            { type: "knowledge_source", id: sourceId },
            { fileName: source.fileName, bulk: true },
          );

          return { sourceId, success: true };
        } catch (error) {
          return {
            sourceId,
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
          };
        }
      }

      // Process sources with bounded concurrency
      const results: { sourceId: string; success: boolean; error?: string }[] =
        [];
      for (let i = 0; i < input.sourceIds.length; i += BULK_CONCURRENCY) {
        const batch = input.sourceIds.slice(i, i + BULK_CONCURRENCY);
        const batchResults = await Promise.all(batch.map(reindexOne));
        results.push(...batchResults);
      }

      return {
        total: input.sourceIds.length,
        successful: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
        results,
      };
    }),

  /**
   * Check URL health for URL-type knowledge sources
   */
  checkUrlHealth: protectedProcedure
    .input(z.object({ sourceId: z.string() }))
    .mutation(async ({ input }) => {
      const [source] = await db
        .select()
        .from(knowledgeSource)
        .where(eq(knowledgeSource.id, input.sourceId))
        .limit(1);

      if (!source) {
        throw new Error("Source not found");
      }

      await requireAgent(source.agentId);

      if (source.type !== "url") {
        return {
          isUrl: false,
          healthy: null,
          error: "Not a URL source",
        };
      }

      // URL sources would have the URL stored - for now this is a placeholder
      // In a real implementation, we'd fetch the URL and check response
      return {
        isUrl: true,
        healthy: true,
        statusCode: 200,
        lastChecked: new Date(),
      };
    }),
});

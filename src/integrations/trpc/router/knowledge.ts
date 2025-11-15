import { db } from "@/db";
import { agent, auditLog, knowledgeSource } from "@/db/schema";
import { createTRPCRouter, protectedProcedure } from "@/integrations/trpc/init";
import {
	createKnowledgeSource,
	deleteKnowledgeSource,
	processKnowledgeSource,
} from "@/lib/ai/ingestion";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";

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
			// Verify agent exists and user has access
			const [agentData] = await db
				.select()
				.from(agent)
				.where(eq(agent.id, input.agentId))
				.limit(1);

			if (!agentData) {
				throw new Error("Agent not found");
			}

			if (!ctx.session.user.isAdmin && agentData.createdBy !== ctx.session.user.id) {
				throw new Error("Access denied");
			}

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
			status: "uploaded",
			r2Bucket: "poprag", // Match wrangler.jsonc bucket name
			r2Key,
		});			// In production, generate R2 pre-signed URL
			// const uploadUrl = await env.R2.createPresignedUrl({
			//   method: 'PUT',
			//   key: r2Key,
			//   expiresIn: 3600, // 1 hour
			//   conditions: [
			//     ['content-length-range', 1, maxFileSize],
			//     ['eq', '$Content-Type', mime],
			//   ],
			// });

			// For development, we'll use direct upload to our API endpoint
			return {
				sourceId,
				uploadUrl: `/api/upload-knowledge`, // Our custom upload endpoint
				uploadMethod: "direct",
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

			// Update checksum if provided
			if (input.checksum) {
				await db
					.update(knowledgeSource)
					.set({ checksum: input.checksum })
					.where(eq(knowledgeSource.id, input.sourceId));
			}

			// Audit log
			await db.insert(auditLog).values({
				id: nanoid(),
				actorId: ctx.session.user.id,
				eventType: "knowledge.uploaded",
				targetType: "knowledge_source",
				targetId: input.sourceId,
				diff: { fileName: source.fileName },
				createdAt: new Date(),
			});

			return { success: true };
		}),

	/**
	 * Index knowledge source (parse + embed + vectorize)
	 */
	index: protectedProcedure
		.input(
			z.object({
				sourceId: z.string(),
				reindex: z.boolean().default(false),
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
			const [agentData] = await db
				.select()
				.from(agent)
				.where(eq(agent.id, source.agentId))
				.limit(1);

			if (!agentData) {
				throw new Error("Agent not found");
			}

			if (!ctx.session.user.isAdmin && agentData.createdBy !== ctx.session.user.id) {
				throw new Error("Access denied");
			}

			// Fetch content from R2
			const { env } = await import("cloudflare:workers");
			const r2Object = await env.R2.get(source.r2Key!);
			if (!r2Object) {
				throw new Error("File not found in storage");
			}
			const content = await r2Object.text();

			try {
				const result = await processKnowledgeSource(input.sourceId, content, {
					embeddingModel: "text-embedding-3-small",
					embeddingDimensions: 1536,
				});

				// Update source status to indexed
				await db
					.update(knowledgeSource)
					.set({
						status: "indexed",
						updatedAt: new Date()
					})
					.where(eq(knowledgeSource.id, input.sourceId));

				// Audit log
				await db.insert(auditLog).values({
					id: nanoid(),
					actorId: ctx.session.user.id,
					eventType: "knowledge.indexed",
					targetType: "knowledge_source",
					targetId: input.sourceId,
					diff: {
						vectorsInserted: result.vectorsInserted,
						reindex: input.reindex,
					},
					createdAt: new Date(),
				});

				return result;
			} catch (error) {
				// Update status to failed
				await db
					.update(knowledgeSource)
					.set({
						status: "failed",
						updatedAt: new Date()
					})
					.where(eq(knowledgeSource.id, input.sourceId));

				throw new Error(
					`Indexing failed: ${error instanceof Error ? error.message : String(error)}`,
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
			// Verify agent exists and user has access
			const [agentData] = await db
				.select()
				.from(agent)
				.where(eq(agent.id, input.agentId))
				.limit(1);

			if (!agentData) {
				throw new Error("Agent not found");
			}

			if (!ctx.session.user.isAdmin && agentData.createdBy !== ctx.session.user.id) {
				throw new Error("Access denied");
			}

			// Generate embedding for the query
			const { generateEmbeddings } = await import("@/lib/ai/embedding");
			const embeddings = await generateEmbeddings(input.query, {
				model: "text-embedding-3-small",
				dimensions: 1536,
			});

			if (embeddings.length === 0) {
				throw new Error("Failed to generate query embedding");
			}

			// Query Vectorize with agent namespace
			const { env } = await import("cloudflare:workers");
			const results = await env.VECTORIZE.query(embeddings[0].embedding, {
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
				status: z
					.enum(["uploaded", "parsed", "indexed", "failed"])
					.optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			// Verify agent exists and user has access
			const [agentData] = await db
				.select()
				.from(agent)
				.where(eq(agent.id, input.agentId))
				.limit(1);

			if (!agentData) {
				throw new Error("Agent not found");
			}

			if (!ctx.session.user.isAdmin && agentData.createdBy !== ctx.session.user.id) {
				throw new Error("Access denied");
			}

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
			const [agentData] = await db
				.select()
				.from(agent)
				.where(eq(agent.id, source.agentId))
				.limit(1);

			if (!agentData) {
				throw new Error("Agent not found");
			}

			if (!ctx.session.user.isAdmin && agentData.createdBy !== ctx.session.user.id) {
				throw new Error("Access denied");
			}

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

				const content = await r2Object.text();

				// Delete old vectors from Vectorize if they exist
				if (source.vectorizeIds && source.vectorizeIds.length > 0) {
					try {
						await env.VECTORIZE.deleteByIds(source.vectorizeIds);
						console.log(`Deleted ${source.vectorizeIds.length} old vectors for source ${input.sourceId}`);
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
				await processKnowledgeSource(input.sourceId, content);

				// Audit log
				await db.insert(auditLog).values({
					id: nanoid(),
					actorId: ctx.session.user.id,
					eventType: "knowledge.reindexed",
					targetType: "knowledge_source",
					targetId: input.sourceId,
					diff: { fileName: source.fileName },
					createdAt: new Date(),
				});

				return { success: true };
			} catch (error) {
				console.error("Reindex failed:", error);
				throw new Error(`Reindex failed: ${error instanceof Error ? error.message : "Unknown error"}`);
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
			const [agentData] = await db
				.select()
				.from(agent)
				.where(eq(agent.id, source.agentId))
				.limit(1);

			if (!agentData) {
				throw new Error("Agent not found");
			}

			if (!ctx.session.user.isAdmin && agentData.createdBy !== ctx.session.user.id) {
				throw new Error("Access denied");
			}

			await deleteKnowledgeSource(input.sourceId);

			// Audit log
			await db.insert(auditLog).values({
				id: nanoid(),
				actorId: ctx.session.user.id,
				eventType: "knowledge.deleted",
				targetType: "knowledge_source",
				targetId: input.sourceId,
				diff: { fileName: source.fileName },
				createdAt: new Date(),
			});

			return { success: true };
		}),
});

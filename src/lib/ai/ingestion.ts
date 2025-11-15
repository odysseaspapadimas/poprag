import { db } from "@/db";
import {
	knowledgeSource,
	type InsertKnowledgeSource,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { generateEmbeddings } from "./embedding";

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
 * Wait for a Vectorize mutation to be processed
 */
export async function waitForMutation(
	vectorize: any,
	mutationId: string,
	maxWaitMs: number = 30000,
	pollIntervalMs: number = 1000
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

		await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
	}

	throw new Error(`Mutation ${mutationId} did not complete within ${maxWaitMs}ms`);
}
export async function checkMutationStatus(vectorize: any, mutationId: string): Promise<boolean> {
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
 * In production, this would handle various file types (PDF, XLSX, DOCX)
 * For now, handles plain text
 */
export async function parseDocument(
	content: string | Buffer,
	mimeType: string,
): Promise<ParsedDocument> {
	// Handle plain text
	if (mimeType.startsWith("text/")) {
		const text = typeof content === "string" ? content : content.toString("utf-8");
		return {
			content: text,
			metadata: { mimeType, originalLength: text.length },
		};
	}

	// For Excel/CSV files
	if (
		mimeType.includes("spreadsheet") ||
		mimeType.includes("csv") ||
		mimeType.includes("excel")
	) {
		// In production, use a library like xlsx or csv-parse
		// For now, treat as text
		const text = typeof content === "string" ? content : content.toString("utf-8");
		return {
			content: text,
			metadata: { mimeType, type: "spreadsheet" },
		};
	}

	// For PDF files
	if (mimeType === "application/pdf") {
		// In production, use pdf-parse or similar
		throw new Error("PDF parsing not yet implemented - use WASM library");
	}

	throw new Error(`Unsupported file type: ${mimeType}`);
}

/**
 * Process and index a knowledge source
 * Full pipeline: parse → embed → store in Vectorize
 */
export async function processKnowledgeSource(
	sourceId: string,
	content: string | Buffer,
	options?: {
		embeddingModel?: string;
		embeddingDimensions?: number;
		chunkSize?: number;
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

	// Validate that agent exists (foreign key constraint check)
	console.log(`Processing knowledge source: sourceId=${sourceId}, agentId=${source.agentId}`);

	try {
		// Update status to parsing
		await db
			.update(knowledgeSource)
			.set({ status: "parsed", updatedAt: new Date() })
			.where(eq(knowledgeSource.id, sourceId));

		// Parse document
		const parsed = await parseDocument(content, source.mime || "text/plain");

		// Generate embeddings with consistent dimensions (MUST match query dimensions)
		const embeddings = await generateEmbeddings(parsed.content, {
			model: options?.embeddingModel,
			dimensions: options?.embeddingDimensions || 1536, // Default to match EMBEDDING_DIMENSIONS
		});
		
		console.log(`Generated ${embeddings.length} embeddings for source ${sourceId}`);

		// Create vector IDs for Vectorize (no chunk records needed)
		const vectorizeIds: string[] = embeddings.map(() => nanoid());
		
		console.log(`Processing ${embeddings.length} embeddings for source ${sourceId}, agent ${source.agentId}`);

		// Insert vectors into Vectorize with agent-based namespace (store full text in metadata)
		const { env } = await import("cloudflare:workers");
		const vectors = embeddings.map((emb, idx) => {
			// Ensure text doesn't exceed Vectorize metadata limits (3KB)
			const textContent = emb.content;
			const MAX_TEXT_SIZE = 2800; // Leave buffer for JSON overhead
			
			if (textContent.length > MAX_TEXT_SIZE) {
				console.warn(`Chunk ${idx} text too large (${textContent.length} bytes), truncating to ${MAX_TEXT_SIZE}`);
			}
			
			return {
				id: vectorizeIds[idx],
				values: emb.embedding,
				namespace: source.agentId, // Agent-based isolation
				metadata: {
					sourceId: source.id,
					agentId: source.agentId,
					fileName: source.fileName || "unknown",
					chunkIndex: idx,
					textLength: textContent.length,
					text: textContent.substring(0, MAX_TEXT_SIZE), // Store text, respecting metadata limits
				},
			};
		});

		const vectorizeResult = await env.VECTORIZE.upsert(vectors);
		console.log(`Inserted ${vectors.length} vectors into Vectorize namespace: ${source.agentId}, mutationId: ${vectorizeResult.mutationId}`);

		// Store vectorize IDs in knowledge source record for deletion tracking
		await db
			.update(knowledgeSource)
			.set({
				vectorizeIds: vectorizeIds,
				updatedAt: new Date(),
			})
			.where(eq(knowledgeSource.id, sourceId));

		// Optional: Wait for mutation to be processed (uncomment if needed)
		// await waitForMutation(env.VECTORIZE, vectorizeResult.mutationId);

		// Update source status
		await db
			.update(knowledgeSource)
			.set({
				status: "indexed",
				updatedAt: new Date(),
			})
			.where(eq(knowledgeSource.id, sourceId));

		return {
			success: true,
			vectorsInserted: vectors.length,
			mutationId: vectorizeResult.mutationId,
		};
	} catch (error) {
		// Log detailed error for debugging - preserve original error
		console.error("Indexing failed - detailed error:", {
			error: error, // Log the full error object
			message: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
			cause: error instanceof Error ? (error as any).cause : undefined,
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

		throw error;
	}
}

/**
 * Create knowledge source record
 */
export async function createKnowledgeSource(
	data: Omit<InsertKnowledgeSource, "createdAt" | "updatedAt">,
): Promise<string> {
	const id = data.id || nanoid();
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
			console.log(`Initiated deletion of ${source.vectorizeIds.length} vectors from Vectorize namespace: ${source.agentId}, mutationId: ${deleteResult.mutationId}`);
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

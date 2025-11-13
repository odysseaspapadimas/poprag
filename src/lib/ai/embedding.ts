import { openai } from "@ai-sdk/openai";
import { embed, embedMany } from "ai";

/**
 * Default embedding model configuration
 * Can be overridden per agent via model alias system
 */
const embeddingModel = openai.embedding("text-embedding-3-small");

/**
 * Chunking strategy: split by sentences (period-based)
 * For production, consider more sophisticated strategies:
 * - Semantic chunking (context-aware)
 * - Sliding window with overlap
 * - Document structure-aware (headers, paragraphs)
 */
export function generateChunks(input: string): string[] {
	return input
		.trim()
		.split(".")
		.filter((chunk) => chunk.trim() !== "")
		.map((chunk) => chunk.trim());
}

/**
 * Generate embeddings for multiple values (batch processing)
 * Used during ingestion pipeline
 */
export async function generateEmbeddings(
	value: string,
	options?: {
		model?: string;
		dimensions?: number;
	},
): Promise<Array<{ embedding: number[]; content: string }>> {
	const chunks = generateChunks(value);
	const model = options?.model
		? openai.embedding(options.model)
		: embeddingModel;

	const { embeddings } = await embedMany({
		model,
		values: chunks,
		...(options?.dimensions && {
			providerOptions: {
				openai: { dimensions: options.dimensions },
			},
		}),
	});

	return embeddings.map((e, i) => ({ content: chunks[i], embedding: e }));
}

/**
 * Generate single embedding for a query
 * Used during retrieval
 */
export async function generateEmbedding(
	value: string,
	options?: {
		model?: string;
		dimensions?: number;
	},
): Promise<number[]> {
	const input = value.replaceAll("\n", " ");
	const model = options?.model
		? openai.embedding(options.model)
		: embeddingModel;

	const { embedding } = await embed({
		model,
		value: input,
		...(options?.dimensions && {
			providerOptions: {
				openai: { dimensions: options.dimensions },
			},
		}),
	});

	return embedding;
}

/**
 * Find relevant content using cosine similarity via Cloudflare Vectorize
 */
export async function findRelevantContent(
	userQuery: string,
	agentId: string,
	options?: {
		topK?: number;
		minSimilarity?: number;
		indexVersion?: number;
	},
) {
	const { topK = 6, minSimilarity = 0.5, indexVersion } = options || {};

	try {
		// Generate embedding for the query
		const queryEmbedding = await generateEmbedding(userQuery);
		
		// Query Vectorize with agent namespace
		const { env } = await import("cloudflare:workers");
		const results = await env.VECTORIZE.query(queryEmbedding, {
			namespace: agentId, // Agent-based isolation
			topK,
			returnValues: false, // We don't need the vectors back
			returnMetadata: true, // We want the full metadata including text
		});

		// Transform results to match expected format
		const matches = results.matches
			.filter(match => match.score >= minSimilarity)
			.map(match => ({
				id: match.id,
				score: match.score,
				content: (match.metadata as any)?.text || "", // Full text from Vectorize metadata
				metadata: match.metadata as Record<string, unknown>,
			}));

		return {
			matches,
			query: userQuery,
		};
	} catch (error) {
		console.error("Error querying Vectorize:", error);
		// Return empty results on error rather than failing the chat
		return {
			matches: [],
			query: userQuery,
		};
	}
}

/**
 * Calculate cosine similarity between two embeddings
 */
export function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length) {
		throw new Error("Vectors must have the same length");
	}

	let dotProduct = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < a.length; i++) {
		dotProduct += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}

	return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

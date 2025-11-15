import { openai } from "@ai-sdk/openai";
import { embed, embedMany } from "ai";

/**
 * Default embedding model configuration
 * Can be overridden per agent via model alias system
 * 
 * IMPORTANT: Cloudflare Vectorize has strict limits:
 * - Metadata max size: 3KB per vector
 * - text-embedding-3-small: 1536 dimensions (default)
 * - For smaller metadata, can use dimensions: 512 or 1024
 */
const EMBEDDING_DIMENSIONS = 1536; // Must match what's indexed in Vectorize
const embeddingModel = openai.embedding("text-embedding-3-small");

/**
 * Cloudflare Vectorize metadata size limit (bytes)
 * Leave buffer for JSON overhead and other fields
 */
const VECTORIZE_METADATA_LIMIT = 2800; // 3KB limit with buffer

/**
 * Chunking strategy with overlap for better context preservation
 * Based on RAG best practices:
 * - Configurable chunk size optimized for metadata limits (800-1000 chars)
 * - 20% overlap between chunks to preserve context
 * - Respects document structure (headers, paragraphs)
 * - Filters out very small chunks
 * - Respects Vectorize 3KB metadata limit
 */
export function generateChunks(
	input: string,
	options?: {
		chunkSize?: number;
		overlapPercentage?: number;
		minChunkSize?: number;
		maxChunkSize?: number; // Hard limit for metadata
	}
): string[] {
	const {
		chunkSize = 800, // Reduced to stay within metadata limits
		overlapPercentage = 0.2,
		minChunkSize = 100,
		maxChunkSize = 2000, // Hard cap for Vectorize metadata
	} = options || {};

	const overlapSize = Math.floor(chunkSize * overlapPercentage);

	// Split by markdown headers (##, ###, etc) to respect document structure
	const headerSections = input.split(/(?=^#{1,6}\s)/m);

	const chunks: string[] = [];
	let previousOverlap = "";

	for (const section of headerSections) {
		if (!section.trim()) continue;

		// Extract header if present
		const headerMatch = section.match(/^(#{1,6}\s.+?)\n/);
		const header = headerMatch ? headerMatch[1] : "";
		const content = header ? section.slice(header.length + 1) : section;

		// If section is small enough, keep it as-is with overlap
		if (section.length <= chunkSize) {
			const chunkWithOverlap = previousOverlap
				? previousOverlap + "\n\n" + section.trim()
				: section.trim();
			chunks.push(chunkWithOverlap);
			
			// Update overlap for next chunk
			const sectionText = section.trim();
			if (sectionText.length > overlapSize) {
				previousOverlap = sectionText.slice(-overlapSize);
			}
			continue;
		}

		// For larger sections, split by paragraphs with overlap
		const paragraphs = content.split(/\n\n+/).filter((p) => p.trim() !== "");

		let currentChunk = previousOverlap ? previousOverlap + "\n\n" : "";
		if (header) {
			currentChunk += header + "\n\n";
		}

		for (let i = 0; i < paragraphs.length; i++) {
			const paragraph = paragraphs[i];
			const combined = currentChunk + paragraph;

			// If combined chunk exceeds size, save current and start new with overlap
			if (combined.length > chunkSize && currentChunk.length > minChunkSize) {
				chunks.push(currentChunk.trim());
				
				// Create overlap from end of current chunk
				const overlapText = currentChunk.slice(-overlapSize);
				currentChunk = header ? header + "\n\n" + overlapText + "\n\n" + paragraph : overlapText + "\n\n" + paragraph;
			} else {
				currentChunk = i === 0 ? currentChunk + paragraph : currentChunk + "\n\n" + paragraph;
			}
		}

		// Push remaining chunk
		if (currentChunk.trim().length >= minChunkSize) {
			chunks.push(currentChunk.trim());
			// Update overlap for next section
			if (currentChunk.trim().length > overlapSize) {
				previousOverlap = currentChunk.trim().slice(-overlapSize);
			}
		}
	}

	// Filter and enforce max size for Vectorize metadata limits
	const filteredChunks = chunks
		.filter((chunk) => chunk.length >= minChunkSize)
		.map((chunk) => {
			if (chunk.length > maxChunkSize) {
				console.warn(`Chunk exceeds max size (${chunk.length} > ${maxChunkSize}), truncating`);
				return chunk.substring(0, maxChunkSize);
			}
			return chunk;
		});
	
	console.log(`Generated ${filteredChunks.length} chunks from ${input.length} characters`);
	console.log(`Chunk sizes: min=${Math.min(...filteredChunks.map(c => c.length))}, max=${Math.max(...filteredChunks.map(c => c.length))}, avg=${Math.floor(filteredChunks.reduce((sum, c) => sum + c.length, 0) / filteredChunks.length)}`);
	if (filteredChunks.length > 0) {
		console.log(`First chunk preview (${filteredChunks[0].length} chars): ${filteredChunks[0].substring(0, 100)}...`);
	}
	
	return filteredChunks;
}

/**
 * Generate embeddings for multiple values (batch processing)
 * Used during ingestion pipeline
 * 
 * CRITICAL: dimensions MUST match between indexing and querying
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

	// Always use consistent dimensions
	const dimensions = options?.dimensions || EMBEDDING_DIMENSIONS;

	const { embeddings } = await embedMany({
		model,
		values: chunks,
		providerOptions: {
			openai: { dimensions },
		},
	});

	console.log(`Generated ${embeddings.length} embeddings with ${dimensions} dimensions`);

	return embeddings.map((e, i) => ({ content: chunks[i], embedding: e }));
}

/**
 * Generate single embedding for a query
 * Used during retrieval
 * 
 * CRITICAL: dimensions MUST match what was used during indexing
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

	// Always use consistent dimensions
	const dimensions = options?.dimensions || EMBEDDING_DIMENSIONS;

	const { embedding } = await embed({
		model,
		value: input,
		providerOptions: {
			openai: { dimensions },
		},
	});

	console.log(`Generated query embedding with ${dimensions} dimensions for: "${input.substring(0, 50)}..."`);

	return embedding;
}

/**
 * Find relevant content using cosine similarity via Cloudflare Vectorize
 * Implements best practices for retrieval quality
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
	const { topK = 6, minSimilarity = 0.3, indexVersion } = options || {};

	try {
		// Preprocess query - remove noise and normalize
		const cleanedQuery = userQuery.trim();
		
		if (!cleanedQuery) {
			console.warn("[RAG] Empty query provided");
			return { matches: [], query: userQuery };
		}
		
		console.log(`[RAG] Searching for: "${cleanedQuery.substring(0, 100)}..." in namespace: ${agentId}`);
		console.log(`[RAG] Query params: topK=${topK}, minSimilarity=${minSimilarity}`);
		
		// Generate embedding for the query with consistent dimensions
		const queryEmbedding = await generateEmbedding(cleanedQuery, {
			dimensions: EMBEDDING_DIMENSIONS,
		});
		
		console.log(`[RAG] Query embedding generated: ${queryEmbedding.length} dimensions`);
		
		// Query Vectorize with agent namespace
		const { env } = await import("cloudflare:workers");
		
		if (!env.VECTORIZE) {
			throw new Error("VECTORIZE binding not available");
		}
		
		const results = await env.VECTORIZE.query(queryEmbedding, {
			namespace: agentId, // Agent-based isolation
			topK: Math.min(topK * 3, 50), // Fetch more for filtering, but cap to avoid performance issues
			returnValues: false, // We don't need the vectors back
			returnMetadata: "all", // Get all metadata including text
		});

		console.log(`[RAG] Vectorize returned ${results.matches?.length || 0} raw results`);
		
		if (!results.matches || results.matches.length === 0) {
			console.warn(`[RAG] No matches found - namespace may be empty or embeddings not indexed yet`);
			console.warn(`[RAG] Query was: "${cleanedQuery.substring(0, 100)}..."`);
			return {
				matches: [],
				query: userQuery,
			};
		}

		// Debug: Log first raw match for inspection
		if (results.matches.length > 0) {
			const firstMatch = results.matches[0];
			console.log(`[RAG] First raw match sample:`, {
				id: firstMatch.id,
				score: firstMatch.score,
				hasMetadata: !!firstMatch.metadata,
				hasText: !!firstMatch.metadata?.text,
				textLength: firstMatch.metadata?.text ? String(firstMatch.metadata.text).length : 0,
				textPreview: firstMatch.metadata?.text ? String(firstMatch.metadata.text).substring(0, 100) : "N/A",
				metadataKeys: firstMatch.metadata ? Object.keys(firstMatch.metadata) : [],
			});
		}

		// Transform and filter results
		const matches = results.matches
			.filter(match => {
				// Validate metadata structure
				if (!match.metadata) {
					console.warn(`[RAG] Match ${match.id} has no metadata object`);
					return false;
				}
				
				// Check for text content
				const hasText = match.metadata.text && String(match.metadata.text).trim().length > 0;
				if (!hasText) {
					console.warn(`[RAG] Match ${match.id} missing text field in metadata. Available fields: ${Object.keys(match.metadata).join(", ")}`);
					return false;
				}
				
				// Check similarity threshold
				const meetsThreshold = match.score >= minSimilarity;
				if (!meetsThreshold) {
					console.debug(`[RAG] Match ${match.id} score ${match.score.toFixed(3)} below threshold ${minSimilarity}`);
					return false;
				}
				
				return true;
			})
			.map(match => {
				const textContent = String(match.metadata?.text || "");
				return {
					id: match.id,
					score: match.score,
					content: textContent,
					metadata: {
						...match.metadata,
						fileName: match.metadata?.fileName || "Unknown source",
						sourceId: match.metadata?.sourceId,
						chunkIndex: match.metadata?.chunkIndex,
						contentLength: textContent.length,
					},
				};
			})
			// Sort by score descending (Vectorize should return sorted, but ensure it)
			.sort((a, b) => b.score - a.score)
			// Take only topK after filtering
			.slice(0, topK);

		if (matches.length === 0) {
			console.warn(`[RAG] All ${results.matches.length} results filtered out. Check metadata structure and similarity threshold.`);
		} else {
			console.log(`[RAG] Returning ${matches.length} matches after filtering from ${results.matches.length} raw results`);
			console.log(`[RAG] Score range: ${matches[0].score.toFixed(3)} to ${matches[matches.length - 1].score.toFixed(3)}`);
			console.log(`[RAG] Content lengths: ${matches.map(m => m.metadata.contentLength).join(", ")}`);
		}

		return {
			matches,
			query: userQuery,
		};
	} catch (error) {
		console.error("[RAG] Critical error querying Vectorize:", error);
		console.error("[RAG] Error details:", {
			message: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : "No stack trace",
			agentId,
			query: userQuery.substring(0, 100),
		});
		// Return empty results on error rather than failing the chat
		return {
			matches: [],
			query: userQuery,
			error: error instanceof Error ? error.message : String(error),
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

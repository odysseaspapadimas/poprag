import { env } from "cloudflare:workers";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * Default embedding model configuration
 * Can be overridden per agent via model alias system
 *
 * IMPORTANT: Cloudflare Vectorize has strict limits:
 * - Metadata max size: 3KB per vector
 * - BGE Large EN v1.5: 1024 dimensions
 *
 * NOTE: Vectorize index must be configured with matching dimensions!
 */
const EMBEDDING_DIMENSIONS = 1024; // BGE Large EN v1.5 uses 1024 dimensions

/**
 * Cloudflare Vectorize metadata size limit (bytes)
 * Leave buffer for JSON overhead and other fields
 */
const VECTORIZE_METADATA_LIMIT = 2800; // 3KB limit with buffer

/**
 * Chunking strategy using LangChain's RecursiveCharacterTextSplitter
 * Based on contextual RAG best practices:
 * - Intelligently splits on content boundaries (paragraphs, sentences)
 * - Configurable chunk size (1024 chars) with overlap (200 chars)
 * - Respects document structure and maintains context
 * - Filters out very small chunks
 * - Respects Vectorize 3KB metadata limit
 */
export async function generateChunks(
  input: string,
  options?: {
    chunkSize?: number;
    chunkOverlap?: number;
    minChunkSize?: number;
    maxChunkSize?: number; // Hard limit for metadata
  },
): Promise<string[]> {
  const {
    chunkSize = 1024, // Optimized for semantic coherence
    chunkOverlap = 200, // Helps maintain context across chunks
    minChunkSize = 100,
    maxChunkSize = 2000, // Hard cap for Vectorize metadata
  } = options || {};

  // Use LangChain's RecursiveCharacterTextSplitter for intelligent splitting
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
  });

  const chunks = await splitter.splitText(input);

  // Filter and enforce size constraints for Vectorize metadata limits
  const filteredChunks = chunks
    .filter((chunk) => chunk.length >= minChunkSize)
    .map((chunk) => {
      if (chunk.length > maxChunkSize) {
        console.warn(
          `Chunk exceeds max size (${chunk.length} > ${maxChunkSize}), truncating`,
        );
        return chunk.substring(0, maxChunkSize);
      }
      return chunk;
    });

  console.log(
    `Generated ${filteredChunks.length} chunks from ${input.length} characters`,
  );
  if (filteredChunks.length > 0) {
    console.log(
      `Chunk sizes: min=${Math.min(
        ...filteredChunks.map((c) => c.length),
      )}, max=${Math.max(
        ...filteredChunks.map((c) => c.length),
      )}, avg=${Math.floor(
        filteredChunks.reduce((sum, c) => sum + c.length, 0) /
          filteredChunks.length,
      )}`,
    );
    console.log(
      `First chunk preview (${
        filteredChunks[0].length
      } chars): ${filteredChunks[0].substring(0, 100)}...`,
    );
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
): Promise<Array<{ embedding: number[]; content: string }>> {
  const chunks = await generateChunks(value);

  // Generate embeddings using Workers AI BGE model through AI Gateway if configured
  const aiOptions = env.AI_GATEWAY_ID
    ? { gateway: { id: env.AI_GATEWAY_ID } }
    : {};
  const embeddings: number[][] = [];

  for (const chunk of chunks) {
    const response = await env.AI.run(
      "@cf/baai/bge-base-en-v1.5",
      {
        text: [chunk],
      },
      aiOptions,
    );
    embeddings.push((response as { data: number[][] }).data[0]);
  }

  console.log(`Generated ${embeddings.length} embeddings with BGE model`);

  return embeddings.map((embedding, i) => ({ content: chunks[i], embedding }));
}

/**
 * Generate single embedding for a query
 * Used during retrieval
 *
 * CRITICAL: dimensions MUST match what was used during indexing
 */
export async function generateEmbedding(value: string): Promise<number[]> {
  const input = value.replaceAll("\n", " ");

  if (!input.trim()) {
    throw new Error("Cannot generate embedding for empty text");
  }

  console.log(`Generating embedding for: "${input.substring(0, 50)}..."`);

  // Use AI Gateway for analytics and caching if configured
  const aiOptions = env.AI_GATEWAY_ID
    ? { gateway: { id: env.AI_GATEWAY_ID } }
    : {};
  const response = await env.AI.run(
    "@cf/baai/bge-large-en-v1.5",
    {
      text: [input],
    },
    aiOptions,
  );

  const embedding = (response as { data: number[][] }).data[0];

  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error(
      `Invalid embedding response: expected array with 1024 dimensions, got ${
        Array.isArray(embedding) ? embedding.length : "non-array"
      }`,
    );
  }

  if (embedding.length !== 1024) {
    throw new Error(
      `Invalid embedding dimensions: expected 1024, got ${embedding.length}`,
    );
  }

  console.log(`Generated embedding with ${embedding.length} dimensions`);

  return embedding;
}

/**
 * Search document chunks using SQLite FTS5
 * Performs full-text search on chunk text
 */
export async function searchDocumentChunksFTS(
  searchTerms: string[],
  agentId: string,
  options?: {
    limit?: number;
  },
): Promise<Array<{ id: string; text: string; rank: number }>> {
  const { limit = 5 } = options || {};

  try {
    // Build FTS queries for each search term
    const queries = searchTerms
      .filter(Boolean)
      .map((term) => {
        // Sanitize term - remove special characters that could break FTS
        const sanitizedTerm = term.trim().replace(/[^\w\s]/g, "");
        if (!sanitizedTerm) return null;
        console.log(sanitizedTerm, "", agentId, " ", limit);
        return sql`
					SELECT document_chunks.id, document_chunks.text, document_chunks_fts.rank
					FROM document_chunks_fts
					JOIN document_chunks ON document_chunks_fts.id = document_chunks.id
					WHERE document_chunks_fts MATCH ${sanitizedTerm}
					  AND document_chunks.agent_id = ${agentId}
					ORDER BY rank DESC
					LIMIT ${limit}
				`;
      })
      .filter(Boolean);

    if (queries.length === 0) {
      return [];
    }

    // Execute all queries in parallel
    const results = await Promise.all(
      queries.map(async (query) => {
        if (!query) return [];
        const result = await db.run(query);
        return (result.results || []) as Array<{
          id: string;
          text: string;
          rank: number;
        }>;
      }),
    );

    // Flatten and deduplicate results
    const allResults = results.flat();
    const uniqueResults = Array.from(
      new Map(allResults.map((r) => [r.id, r])).values(),
    );

    // Sort by rank and limit
    return uniqueResults.sort((a, b) => b.rank - a.rank).slice(0, limit * 2); // Return more for fusion
  } catch (error) {
    console.error("[FTS] Error searching document chunks:", error);
    console.warn(
      "[FTS] Full-text search failed. This may indicate FTS index corruption.",
    );
    console.warn("[FTS] To rebuild the FTS index, run: pnpm db:rebuild-fts");
    console.warn("[FTS] Continuing with vector search only...");
    return [];
  }
}

/**
 * Find relevant content using hybrid search (vector + keyword)
 * Combines semantic similarity (Vectorize) with keyword matching
 * Implements contextual RAG best practices
 */
export async function findRelevantContent(
  userQuery: string,
  agentId: string,
  options?: {
    topK?: number;
    minSimilarity?: number;
    indexVersion?: number;
    keywords?: string[]; // Optional keywords for hybrid search
    useHybridSearch?: boolean; // Enable query rewriting + hybrid search
  },
) {
  const {
    topK = 6,
    minSimilarity = 0.3,
    indexVersion,
    keywords = [],
    useHybridSearch = false,
  } = options || {};

  try {
    // Preprocess query - remove noise and normalize
    const cleanedQuery = userQuery.trim();

    if (!cleanedQuery) {
      console.warn("[RAG] Empty query provided");
      return { matches: [], query: userQuery };
    }

    console.log(
      `[RAG] Searching for: "${cleanedQuery.substring(
        0,
        100,
      )}..." in namespace: ${agentId}`,
    );
    console.log(
      `[RAG] Query params: topK=${topK}, minSimilarity=${minSimilarity}, hybridSearch=${useHybridSearch}`,
    );

    // Generate embedding for the query with consistent dimensions
    const queryEmbedding = await generateEmbedding(cleanedQuery);

    console.log(
      `[RAG] Query embedding generated: ${queryEmbedding.length} dimensions`,
    );

    // Query Vectorize with agent namespace

    if (!env.VECTORIZE) {
      throw new Error("VECTORIZE binding not available");
    }

    const results = await env.VECTORIZE.query(queryEmbedding, {
      namespace: agentId, // Agent-based isolation
      topK: 5,
      returnValues: false, // We don't need the vectors back
      returnMetadata: "all", // Get all metadata including text
    });

    console.log(
      `[RAG] Vectorize returned ${results.matches?.length || 0} raw results`,
    );

    if (!results.matches || results.matches.length === 0) {
      console.warn(
        `[RAG] No matches found - namespace may be empty or embeddings not indexed yet`,
      );
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
        textLength: firstMatch.metadata?.text
          ? String(firstMatch.metadata.text).length
          : 0,
        textPreview: firstMatch.metadata?.text
          ? String(firstMatch.metadata.text).substring(0, 100)
          : "N/A",
        metadataKeys: firstMatch.metadata
          ? Object.keys(firstMatch.metadata)
          : [],
      });
    }

    // Transform and filter results
    const matches = results.matches
      .filter((match) => {
        // Validate metadata structure
        if (!match.metadata) {
          console.warn(`[RAG] Match ${match.id} has no metadata object`);
          return false;
        }

        // Check for text content
        const hasText =
          match.metadata.text && String(match.metadata.text).trim().length > 0;
        if (!hasText) {
          console.warn(
            `[RAG] Match ${
              match.id
            } missing text field in metadata. Available fields: ${Object.keys(
              match.metadata,
            ).join(", ")}`,
          );
          return false;
        }

        // Check similarity threshold
        const meetsThreshold = match.score >= minSimilarity;
        if (!meetsThreshold) {
          console.debug(
            `[RAG] Match ${match.id} score ${match.score.toFixed(
              3,
            )} below threshold ${minSimilarity}`,
          );
          return false;
        }

        return true;
      })
      .map((match) => {
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
      console.warn(
        `[RAG] All ${results.matches.length} results filtered out. Check metadata structure and similarity threshold.`,
      );
    } else {
      console.log(
        `[RAG] Returning ${matches.length} matches after filtering from ${results.matches.length} raw results`,
      );
      console.log(
        `[RAG] Score range: ${matches[0].score.toFixed(3)} to ${matches[
          matches.length - 1
        ].score.toFixed(3)}`,
      );
      console.log(
        `[RAG] Content lengths: ${matches
          .map((m) => m.metadata.contentLength)
          .join(", ")}`,
      );
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

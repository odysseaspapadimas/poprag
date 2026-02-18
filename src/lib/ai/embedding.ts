import { env } from "cloudflare:workers";
import { createOpenAI } from "@ai-sdk/openai";
import {
  MarkdownTextSplitter,
  RecursiveCharacterTextSplitter,
} from "@langchain/textsplitters";
import { embedMany } from "ai";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import {
  DEFAULT_MODELS,
  EMBEDDING_CONFIG,
  RAG_CONFIG,
} from "@/lib/ai/constants";
import { resolveModelConfig } from "@/lib/ai/helpers";

/**
 * Embedding configuration
 * Platform-wide: all agents use text-embedding-3-small at 768 Matryoshka dimensions
 *
 * IMPORTANT: Cloudflare Vectorize limits:
 * - Metadata max size: 3KB per vector (we store only lightweight fields, not chunk text)
 * - Max dimensions: 1536 (we use 768 for faster queries)
 * - Chunk text is stored exclusively in D1 and fetched by enrichWithFullText()
 *
 * NOTE: Vectorize index must be configured with 768 dimensions!
 */

export interface EmbeddingRequestOptions {
  model?: string;
  dimensions?: number;
  abortSignal?: AbortSignal;
}

interface ResolvedEmbeddingConfig {
  modelAlias: string;
  modelId: string;
  provider: string;
  expectedDimensions: number;
  requestedDimensions?: number;
  abortSignal?: AbortSignal;
}

async function resolveEmbeddingConfig(
  options?: EmbeddingRequestOptions,
): Promise<ResolvedEmbeddingConfig> {
  const modelAlias = options?.model || DEFAULT_MODELS.EMBEDDING;
  const modelConfig = await resolveModelConfig(modelAlias);

  // Platform-wide: always use configured dimensions (768 Matryoshka for text-embedding-3-small)
  return {
    modelAlias,
    modelId: modelConfig.modelId,
    provider: modelConfig.provider,
    expectedDimensions: EMBEDDING_CONFIG.DIMENSIONS,
    requestedDimensions: EMBEDDING_CONFIG.DIMENSIONS,
    abortSignal: options?.abortSignal,
  };
}

async function runEmbeddingRequest(
  inputs: string[],
  config: ResolvedEmbeddingConfig,
): Promise<number[][]> {
  switch (config.provider) {
    case "cloudflare-workers-ai": {
      if (!env.AI) {
        throw new Error("Workers AI binding not available");
      }
      const aiOptions = env.AI_GATEWAY_ID
        ? { gateway: { id: env.AI_GATEWAY_ID } }
        : {};
      const response = await env.AI.run(
        config.modelId as keyof AiModels,
        { text: inputs },
        aiOptions,
      );
      return (response as { data: number[][] }).data;
    }
    case "openai": {
      if (!env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY is required for OpenAI embeddings");
      }
      const openaiProvider = createOpenAI({ apiKey: env.OPENAI_API_KEY });
      const model = openaiProvider.embedding(config.modelId);
      const providerOptions = config.requestedDimensions
        ? { openai: { dimensions: config.requestedDimensions } }
        : undefined;
      const result = await embedMany({
        model,
        values: inputs,
        abortSignal: config.abortSignal,
        providerOptions,
      });
      return result.embeddings as number[][];
    }
    default:
      throw new Error(
        `Embedding not supported for provider: ${config.provider}`,
      );
  }
}

function assertValidEmbedding(
  embedding: number[] | undefined,
  expectedDimensions: number,
  index?: number,
): void {
  const label = index === undefined ? "embedding" : `embedding ${index}`;
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error(
      `Invalid ${label} response: expected array with ${expectedDimensions} dimensions, got ${Array.isArray(embedding) ? embedding.length : "non-array"}`,
    );
  }
  if (embedding.length !== expectedDimensions) {
    throw new Error(
      `Invalid ${label} dimensions: expected ${expectedDimensions}, got ${embedding.length}`,
    );
  }
}

/**
 * Chunking strategy using LangChain's RecursiveCharacterTextSplitter
 * Based on contextual RAG best practices:
 * - Intelligently splits on content boundaries (paragraphs, sentences)
 * - Configurable chunk size with overlap
 * - Respects document structure and maintains context
 * - Filters out very small chunks
 */

export async function generateChunks(
  input: string,
  options?: {
    chunkSize?: number;
    chunkOverlap?: number;
    minChunkSize?: number;
    maxChunkSize?: number; // Safety net for oversized chunks
    contentType?: "markdown" | "text";
  },
): Promise<string[]> {
  const {
    chunkSize = 1024, // Optimized for semantic coherence
    chunkOverlap = 200, // Helps maintain context across chunks
    minChunkSize = 100,
    maxChunkSize = 4000, // Safety net — no longer constrained by Vectorize metadata (text stored only in D1)
    contentType = "text",
  } = options || {};

  // Use LangChain's RecursiveCharacterTextSplitter for intelligent splitting
  const splitter =
    contentType === "markdown"
      ? new MarkdownTextSplitter({
          chunkSize,
          chunkOverlap,
        })
      : new RecursiveCharacterTextSplitter({
          chunkSize,
          chunkOverlap,
        });

  const chunks = await splitter.splitText(input);

  // Resplit oversized chunks instead of truncating mid-sentence
  const fallbackOverlap = Math.min(
    chunkOverlap,
    Math.floor(maxChunkSize * 0.2),
  );
  const fallbackSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: maxChunkSize,
    chunkOverlap: fallbackOverlap,
  });

  const normalizedChunks: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxChunkSize) {
      normalizedChunks.push(chunk);
      continue;
    }

    console.warn(
      `Chunk exceeds max size (${chunk.length} > ${maxChunkSize}), resplitting`,
    );
    const subChunks = await fallbackSplitter.splitText(chunk);
    normalizedChunks.push(...subChunks);
  }

  // Filter tiny fragments and enforce max size safety net
  const filteredChunks = normalizedChunks
    .filter((chunk) => chunk.length >= minChunkSize)
    .map((chunk) =>
      chunk.length > maxChunkSize ? chunk.substring(0, maxChunkSize) : chunk,
    );

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
 * Generate single embedding for a query
 * Used during retrieval
 *
 * CRITICAL: dimensions MUST match what was used during indexing
 */
export async function generateEmbedding(
  value: string,
  options?: EmbeddingRequestOptions,
): Promise<number[]> {
  const input = value.replaceAll("\n", " ");

  if (!input.trim()) {
    throw new Error("Cannot generate embedding for empty text");
  }

  const config = await resolveEmbeddingConfig(options);
  console.log(
    `Generating embedding for: "${input.substring(0, 50)}..." using ${config.modelAlias}`,
  );

  const embeddings = await runEmbeddingRequest([input], config);
  if (!Array.isArray(embeddings) || embeddings.length !== 1) {
    throw new Error(
      `Invalid embeddings response: expected 1 embedding, got ${Array.isArray(embeddings) ? embeddings.length : "non-array"}`,
    );
  }

  const embedding = embeddings[0];
  assertValidEmbedding(embedding, config.expectedDimensions);
  console.log(`Generated embedding with ${embedding.length} dimensions`);
  return embedding;
}

/**
 * Generate embeddings for multiple inputs in a single batch
 * Used for query variations and bulk operations
 */
export async function generateEmbeddings(
  values: string[],
  options?: EmbeddingRequestOptions,
): Promise<number[][]> {
  const inputs = values.map((value) => value.replaceAll("\n", " ").trim());

  if (inputs.length === 0) {
    return [];
  }

  if (inputs.some((input) => input.length === 0)) {
    throw new Error("Cannot generate embeddings for empty text");
  }

  const config = await resolveEmbeddingConfig(options);
  console.log(
    `Generating embeddings for ${inputs.length} inputs using ${config.modelAlias}`,
  );

  const embeddings = await runEmbeddingRequest(inputs, config);

  if (!Array.isArray(embeddings) || embeddings.length !== inputs.length) {
    throw new Error(
      `Invalid embeddings response: expected ${inputs.length} embeddings, got ${Array.isArray(embeddings) ? embeddings.length : "non-array"}`,
    );
  }

  embeddings.forEach((embedding, index) => {
    assertValidEmbedding(embedding, config.expectedDimensions, index);
  });

  console.log(
    `Generated ${embeddings.length} embeddings with ${embeddings[0]?.length || 0} dimensions`,
  );

  return embeddings;
}

/**
 * Search document chunks using a precomputed embedding
 * Used for query variations to avoid repeated embedding calls
 */
export async function findRelevantContentWithEmbedding(
  query: string,
  queryEmbedding: number[],
  agentId: string,
  options?: {
    topK?: number;
    minSimilarity?: number;
  },
) {
  const { topK = 6, minSimilarity = RAG_CONFIG.MIN_SIMILARITY } = options || {};

  try {
    // Preprocess query - remove noise and normalize
    const cleanedQuery = query.trim();

    if (!cleanedQuery) {
      console.warn("[RAG] Empty query provided");
      return { matches: [], query };
    }

    console.log(
      `[RAG] Searching for: "${cleanedQuery.substring(
        0,
        100,
      )}..." in namespace: ${agentId}`,
    );
    console.log(
      `[RAG] Query params: topK=${topK}, minSimilarity=${minSimilarity}`,
    );

    console.log(
      `[RAG] Query embedding provided: ${queryEmbedding.length} dimensions`,
    );

    // Query Vectorize with agent namespace

    if (!env.VECTORIZE) {
      throw new Error("VECTORIZE binding not available");
    }

    const results = await env.VECTORIZE.query(queryEmbedding, {
      namespace: agentId, // Agent-based isolation
      topK,
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
        query,
      };
    }

    // Debug: Log first raw match for inspection
    if (results.matches.length > 0) {
      const firstMatch = results.matches[0];
      console.log(`[RAG] First raw match sample:`, {
        id: firstMatch.id,
        score: firstMatch.score,
        hasMetadata: !!firstMatch.metadata,
        metadataKeys: firstMatch.metadata
          ? Object.keys(firstMatch.metadata)
          : [],
      });
    }

    // Transform and filter results using adaptive thresholding
    // OpenAI embeddings produce lower absolute scores than BGE models,
    // so we use both absolute and relative thresholds
    const topScore = results.matches[0]?.score || 0;
    const relativeThreshold = topScore * RAG_CONFIG.RELATIVE_SCORE_THRESHOLD;
    const effectiveThreshold = Math.max(minSimilarity, relativeThreshold);

    console.log(
      `[RAG] Adaptive threshold: absolute=${minSimilarity.toFixed(3)}, relative=${relativeThreshold.toFixed(3)} (top=${topScore.toFixed(3)} * ${RAG_CONFIG.RELATIVE_SCORE_THRESHOLD}), effective=${effectiveThreshold.toFixed(3)}`,
    );

    const matches = results.matches
      .filter((match) => {
        // Validate metadata structure
        if (!match.metadata) {
          console.warn(`[RAG] Match ${match.id} has no metadata object`);
          return false;
        }

        // Check similarity threshold (using effective adaptive threshold)
        const meetsThreshold = match.score >= effectiveThreshold;
        if (!meetsThreshold) {
          console.debug(
            `[RAG] Match ${match.id} score ${match.score.toFixed(
              3,
            )} below effective threshold ${effectiveThreshold.toFixed(3)}`,
          );
          return false;
        }

        return true;
      })
      .map((match) => {
        // Normalize score to 0-1 range for display (based on top score)
        const normalizedScore = topScore > 0 ? match.score / topScore : 0;
        // Content is populated later by enrichWithFullText() from D1
        // Vectorize metadata no longer stores chunk text (only lightweight fields)
        return {
          id: match.id,
          score: normalizedScore, // Normalized for display
          vectorScore: match.score, // Preserve original vector similarity score
          content: "", // Populated by enrichWithFullText() from D1
          metadata: {
            ...match.metadata,
            fileName: match.metadata?.fileName || "Unknown source",
            sourceId: match.metadata?.sourceId,
            chunkIndex: match.metadata?.chunkIndex,
          },
        };
      })
      // Sort by score descending (Vectorize should return sorted, but ensure it)
      .sort((a, b) => b.score - a.score)
      // Take only topK after filtering
      .slice(0, topK);

    // Note: Full text is fetched by enrichWithFullText() in rag-pipeline.ts
    // Vectorize metadata stores only lightweight fields (sourceId, fileName, etc.)
    // to avoid the 3KB metadata limit constraining chunk sizes

    if (matches.length === 0) {
      console.warn(
        `[RAG] All ${results.matches.length} results filtered out. Top raw score was ${topScore.toFixed(3)}, effective threshold was ${effectiveThreshold.toFixed(3)}.`,
      );
    } else {
      console.log(
        `[RAG] Returning ${matches.length} matches after filtering from ${results.matches.length} raw results`,
      );
      console.log(
        `[RAG] Raw score range: ${matches[0].vectorScore.toFixed(3)} to ${matches[
          matches.length - 1
        ].vectorScore.toFixed(
          3,
        )} (normalized: ${matches[0].score.toFixed(3)} to ${matches[matches.length - 1].score.toFixed(3)})`,
      );
    }

    return {
      matches,
      query,
    };
  } catch (error) {
    console.error("[RAG] Critical error querying Vectorize:", error);
    console.error("[RAG] Error details:", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : "No stack trace",
      agentId,
      query: query.substring(0, 100),
    });
    // Return empty results on error rather than failing the chat
    return {
      matches: [],
      query,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
    // Sanitize and filter search terms, then combine into a single compound OR query
    // This reduces N D1 round trips to 1 for better FTS latency
    // NOTE: Use Unicode-aware regex (\p{L}) to preserve non-ASCII characters (Greek, Cyrillic, etc.)
    // The old /[^\w\s]/g only matched ASCII [a-zA-Z0-9_], stripping all non-Latin text
    const sanitizedTerms = searchTerms
      .filter(Boolean)
      .map((term) =>
        term
          .trim()
          .replace(/[^\p{L}\p{N}\s]/gu, "")
          .trim(),
      )
      .filter((term) => term.length > 0);

    if (sanitizedTerms.length === 0) {
      return [];
    }

    // Build compound FTS5 MATCH expression: "term1 OR term2 OR term3"
    // Each term is double-quoted to handle multi-word terms safely
    const compoundMatch = sanitizedTerms
      .map((term) => `"${term}"`)
      .join(" OR ");

    console.log(
      `[FTS] Compound query: ${compoundMatch} for agent ${agentId}, limit ${limit}`,
    );

    const query = sql`
      SELECT document_chunks.id, document_chunks.text, document_chunks_fts.rank
      FROM document_chunks_fts
      JOIN document_chunks ON document_chunks_fts.id = document_chunks.id
      WHERE document_chunks_fts MATCH ${compoundMatch}
        AND document_chunks.agent_id = ${agentId}
      ORDER BY rank ASC
      LIMIT ${limit * 2}
    `;

    const result = await db.run(query);
    const results = (result.results || []) as Array<{
      id: string;
      text: string;
      rank: number;
    }>;

    // Sort by rank (FTS5 rank is negative, lower = better match)
    return results.sort((a, b) => b.rank - a.rank).slice(0, limit * 2); // Return more for fusion
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
  },
) {
  const cleanedQuery = userQuery.trim();

  if (!cleanedQuery) {
    console.warn("[RAG] Empty query provided");
    return { matches: [], query: userQuery };
  }

  // Generate embedding for the query with consistent dimensions
  const queryEmbedding = await generateEmbedding(cleanedQuery);

  return findRelevantContentWithEmbedding(
    userQuery,
    queryEmbedding,
    agentId,
    options,
  );
}

/**
 * Rerank documents using BAAI BGE Reranker
 * Uses @cf/baai/bge-reranker-large
 */
export async function rerank(
  query: string,
  documents: Array<{
    id: string;
    content: string;
    metadata?: Record<string, unknown>;
  }>,
  topK: number = 5,
): Promise<
  Array<{
    id: string;
    content: string;
    score: number;
    metadata?: Record<string, unknown>;
  }>
> {
  if (documents.length === 0) return [];

  try {
    console.log(
      `[Rerank] Reranking ${documents.length} documents for query: "${query.substring(0, 50)}..."`,
    );

    const sourceDocuments = documents.map((d) => d.content);

    // Use AI Gateway if configured
    const aiOptions = env.AI_GATEWAY_ID
      ? { gateway: { id: env.AI_GATEWAY_ID } }
      : {};

    const response = await env.AI.run(
      "@cf/baai/bge-reranker-base",
      {
        query,
        contexts: sourceDocuments.map((text) => ({ text })),
      },
      aiOptions,
    );

    // Response is array of { index: number, score: number }
    // Handle potential differences in response structure between models
    type RerankItem = { index?: number; id?: number; score: number };
    type RerankResponse =
      | { result?: RerankItem[]; response?: RerankItem[] }
      | RerankItem[];

    const typedResponse = response as unknown as RerankResponse;
    const results =
      "result" in typedResponse && typedResponse.result
        ? typedResponse.result
        : "response" in typedResponse && typedResponse.response
          ? typedResponse.response
          : Array.isArray(typedResponse)
            ? typedResponse
            : [];

    if (!Array.isArray(results)) {
      console.warn("[Rerank] Unexpected response format:", response);
      // Fallback: return original documents sliced
      return documents.slice(0, topK).map((d) => ({ ...d, score: 0 }));
    }

    // Map scores back to documents
    const reranked = results.map((res) => {
      const docIndex = res.index ?? res.id;
      if (docIndex === undefined)
        throw new Error("Invalid rerank result: missing index/id");
      const doc = documents[docIndex];
      return {
        ...doc,
        score: res.score,
      };
    });

    // Sort by score descending
    reranked.sort((a, b) => b.score - a.score);

    const finalResults = reranked.slice(0, topK);

    if (finalResults.length > 0) {
      console.log(`[Rerank] Top score: ${finalResults[0].score.toFixed(4)}`);
    }

    return finalResults;
  } catch (error) {
    console.error("[Rerank] Error reranking documents:", error);
    // Fallback to original order
    return documents.slice(0, topK).map((d) => ({ ...d, score: 0 }));
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

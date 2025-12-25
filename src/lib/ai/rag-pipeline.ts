/**
 * RAG Pipeline Module
 * Handles the retrieval-augmented generation flow:
 * - Intent classification
 * - Query rewriting
 * - Hybrid search (vector + FTS)
 * - Result fusion and reranking
 */

import { db } from "@/db";
import { documentChunks, knowledgeSource } from "@/db/schema";
import type { LanguageModel } from "ai";
import { generateText, Output } from "ai";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import { reciprocalRankFusion } from "../utils";
import { DEFAULT_MODELS, RAG_CONFIG } from "./constants";
import {
    findRelevantContent,
    rerank,
    searchDocumentChunksFTS,
} from "./embedding";
import { resolveAndCreateModel } from "./helpers";

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────

export interface RAGConfig {
    enabled: boolean;
    rewriteQuery: boolean;
    rewriteModel?: string;
    intentModel?: string;
    queryVariationsCount?: number;
    rerank: boolean;
    rerankModel?: string;
    topK?: number;
}

export interface RAGDebugInfo {
    enabled: boolean;
    skippedByIntent?: boolean;
    intentReason?: string;
    originalQuery?: string;
    rewrittenQueries?: string[];
    keywords?: string[];
    vectorResultsCount?: number;
    ftsResultsCount?: number;
    rerankEnabled?: boolean;
    rerankModel?: string;
    chunks?: Array<{
        id: string;
        content: string;
        score: number;
        sourceId?: string;
        metadata?: Record<string, unknown>;
    }>;
}

export interface RAGContext {
    chunks: Array<{
        content: string;
        sourceId: string;
        score: number;
        metadata?: Record<string, unknown>;
    }>;
}

export interface RAGResult {
    context: RAGContext | null;
    debugInfo: RAGDebugInfo;
}

interface MatchMetadata {
    sourceId?: string;
    [key: string]: unknown;
}

// ─────────────────────────────────────────────────────
// Intent Classification
// ─────────────────────────────────────────────────────

/**
 * Classify if a query requires knowledge base retrieval
 * Skips RAG for trivial greetings, social messages, and non-informational queries
 */
export async function classifyQueryIntent(
    model: LanguageModel,
    query: string,
): Promise<{ requiresRAG: boolean; reason: string }> {
    try {
        const { output } = await generateText({
            model,
            prompt: `Classify if this user message requires searching a knowledge base for factual information.

Return requiresRAG=true if:
- The user is asking a question that needs factual information
- The user wants to learn something specific
- The query references documents, data, or knowledge

Return requiresRAG=false if:
- It's a greeting (hi, hello, hey, etc.)
- It's a social message (how are you, thanks, bye, etc.)
- It's a simple acknowledgment (ok, sure, yes, no, etc.)
- It's meta-conversation (about the chat itself, not knowledge)
- It's small talk without informational intent

User message: "${query}"`,
            output: Output.object({
                schema: z.object({
                    requiresRAG: z
                        .boolean()
                        .describe(
                            "True if the query asks for information that might be in a knowledge base",
                        ),
                    reason: z.string().describe("Brief explanation of the classification"),
                }),
            }),
        });

        console.log(
            `[Intent Classification] Query: "${query.substring(0, 50)}..." -> requiresRAG: ${output.requiresRAG} (${output.reason})`,
        );

        return output;
    } catch (error) {
        console.warn(
            "[Intent Classification] Failed, defaulting to RAG enabled:",
            error,
        );
        // Fallback to performing RAG if classification fails
        return {
            requiresRAG: true,
            reason: "Classification failed, defaulting to RAG",
        };
    }
}

// ─────────────────────────────────────────────────────
// Query Rewriting
// ─────────────────────────────────────────────────────

/**
 * Query rewriting for improved RAG retrieval
 * Expands user queries into multiple variations to improve search coverage
 */
export async function rewriteQuery(
    model: LanguageModel,
    query: string,
    variationsCount: number = 3,
): Promise<{ queries: string[]; keywords: string[] }> {
    const promptText = `Given the following user message, rewrite it into ${variationsCount} distinct queries that could be used to search for relevant information, and provide additional keywords related to the query.

Each query should focus on different aspects or potential interpretations of the original message.
Each keyword should be derived from an interpretation of the provided user message.

User message: ${query}`;

    try {
        const { output } = await generateText({
            model,
            prompt: promptText,
            output: Output.object({
                schema: z.object({
                    queries: z
                        .array(z.string())
                        .describe(
                            "Similar queries to the user's query. Be concise but comprehensive.",
                        ),
                    keywords: z
                        .array(z.string())
                        .describe("Keywords from the query to use for full-text search"),
                }),
            }),
        });

        console.log(`[Query Rewriting] Original: "${query.substring(0, 50)}..."`);
        console.log(
            `[Query Rewriting] Generated ${output.queries.length} query variations`,
        );
        console.log(
            `[Query Rewriting] Extracted ${output.keywords.length} keywords`,
        );

        return output;
    } catch (error) {
        console.warn("[Query Rewriting] Failed, using original query:", error);
        // Fallback to original query
        return {
            queries: [query],
            keywords: [],
        };
    }
}

// ─────────────────────────────────────────────────────
// Hybrid Search
// ─────────────────────────────────────────────────────

interface HybridSearchResult {
    id: string;
    score: number;
    content: string;
    metadata: Record<string, unknown>;
}

/**
 * Perform hybrid search combining vector and FTS results
 * Uses reciprocal rank fusion to merge result sets
 *
 * Note: FTS operations are wrapped in try-catch to handle potential
 * index corruption gracefully. If FTS fails, we fall back to vector-only search.
 * See docs/FTS_FIX.md for recovery procedures.
 */
export async function hybridSearch(
    queries: string[],
    keywords: string[],
    agentId: string,
    topK: number = RAG_CONFIG.TOP_K,
): Promise<{
    results: HybridSearchResult[];
    vectorCount: number;
    ftsCount: number;
}> {
    // Optimize topK per query variation - fewer results per query, rely on fusion/reranking
    const topKPerQuery = Math.max(3, Math.ceil(topK / queries.length));

    // Step 1: Perform vector search for all query variations
    const vectorSearchPromises = queries.map((q) =>
        findRelevantContent(q, agentId, {
            topK: topKPerQuery,
            minSimilarity: RAG_CONFIG.MIN_SIMILARITY,
        }),
    );

    const vectorResults = await Promise.all(vectorSearchPromises);

    const totalVectorResults = vectorResults.reduce(
        (sum, r) => sum + r.matches.length,
        0,
    );

    console.log(`[Hybrid Search] Vector search: ${totalVectorResults} results (${topKPerQuery} per query)`);

    // Step 2: Check if vector results are high-confidence - skip FTS if so
    const allVectorMatches = vectorResults.flatMap((r) => r.matches);
    const topVectorScore = allVectorMatches.length > 0
        ? Math.max(...allVectorMatches.map((m) => m.score))
        : 0;

    const HIGH_CONFIDENCE_THRESHOLD = 0.85;
    const skipFTS = topVectorScore >= HIGH_CONFIDENCE_THRESHOLD;

    let ftsResults: Array<{ id: string; text: string; rank: number }> = [];

    if (skipFTS) {
        console.log(`[Hybrid Search] High-confidence vector match (${topVectorScore.toFixed(3)}), skipping FTS`);
    } else if (keywords.length > 0) {
        // Step 3: Perform FTS search for keywords (with graceful degradation)
        try {
            ftsResults = await searchDocumentChunksFTS(keywords, agentId, {
                limit: topKPerQuery,
            });
            console.log(`[Hybrid Search] FTS search: ${ftsResults.length} results`);
        } catch (error) {
            // FTS failure is logged in searchDocumentChunksFTS
            console.warn("[Hybrid Search] FTS unavailable, using vector search only");
        }

        if (keywords.length > 0 && ftsResults.length === 0) {
            console.warn(
                "[Hybrid Search] FTS search returned no results despite having keywords. FTS index may need rebuilding.",
            );
        }
    }

    // Step 4: Apply reciprocal rank fusion to merge results
    // Convert FTS results to match format
    const ftsMatches = ftsResults.map((r) => ({
        id: r.id,
        content: r.text,
        score: -r.rank, // FTS rank is negative, convert to positive score
        metadata: {},
    }));

    // Merge all result sets
    const allResultSets = [...vectorResults.map((r) => r.matches), ftsMatches];

    const fusedResults = reciprocalRankFusion(allResultSets, RAG_CONFIG.RRF_K);

    // Return more candidates for reranking (2x topK instead of 3x for speed)
    return {
        results: fusedResults.slice(0, topK * 2),
        vectorCount: totalVectorResults,
        ftsCount: ftsResults.length,
    };
}

// ─────────────────────────────────────────────────────
// Reranking
// ─────────────────────────────────────────────────────

/**
 * Rerank search results using a cross-encoder model
 */
export async function rerankResults(
    query: string,
    candidates: HybridSearchResult[],
    topK: number = RAG_CONFIG.TOP_K,
    rerankModelId?: string,
): Promise<HybridSearchResult[]> {
    if (candidates.length === 0) return [];

    const modelId = rerankModelId || DEFAULT_MODELS.RERANKER;
    console.log(
        `[Rerank] Reranking ${candidates.length} candidates using ${modelId}`,
    );

    const reranked = await rerank(
        query,
        candidates.map((c) => ({
            id: c.id,
            content: String(c.content),
            metadata: c.metadata,
        })),
        topK,
    );

    return reranked.map((r) => ({
        id: r.id,
        score: r.score,
        content: r.content,
        metadata: r.metadata || {},
    }));
}

// ─────────────────────────────────────────────────────
// Main RAG Pipeline
// ─────────────────────────────────────────────────────

/**
 * Execute the full RAG pipeline for a user query
 *
 * @param userQuery - The user's query
 * @param agentId - The agent ID for namespace isolation
 * @param config - RAG configuration from agent settings
 * @returns RAG context and debug info
 */
export async function performRAGRetrieval(
    userQuery: string,
    agentId: string,
    config: RAGConfig,
): Promise<RAGResult> {
    const debugInfo: RAGDebugInfo = { enabled: config.enabled };

    // Early return if RAG is disabled
    if (!config.enabled) {
        return { context: null, debugInfo };
    }

    // Validate query
    if (!userQuery || userQuery.trim().length === 0) {
        return { context: null, debugInfo };
    }

    debugInfo.originalQuery = userQuery;

    // Step 1 & 2: Run intent classification and query rewriting in PARALLEL for speed
    const intentModelId = config.intentModel || DEFAULT_MODELS.INTENT_CLASSIFICATION;
    const rewriteModelId = config.rewriteModel || DEFAULT_MODELS.QUERY_REWRITE;
    const variationsCount = config.queryVariationsCount || 3;

    // Prepare parallel tasks
    const intentPromise = resolveAndCreateModel(intentModelId).then((model) =>
        classifyQueryIntent(model, userQuery)
    );

    const rewritePromise = config.rewriteQuery
        ? resolveAndCreateModel(rewriteModelId).then((model) =>
            rewriteQuery(model, userQuery, variationsCount)
        )
        : Promise.resolve({ queries: [userQuery], keywords: [] as string[] });

    // Execute in parallel
    const [intentClassification, rewriteResult] = await Promise.all([
        intentPromise,
        rewritePromise,
    ]);

    // Check intent result - if RAG not needed, skip (rewrite result is discarded)
    if (!intentClassification.requiresRAG) {
        console.log(
            `[RAG Pipeline] Skipping RAG - query classified as not requiring knowledge: ${intentClassification.reason}`,
        );
        debugInfo.skippedByIntent = true;
        debugInfo.intentReason = intentClassification.reason;
        return { context: null, debugInfo };
    }

    // Use rewrite results
    const queries = rewriteResult.queries;
    const keywords = rewriteResult.keywords;

    if (config.rewriteQuery) {
        debugInfo.rewrittenQueries = queries;
        debugInfo.keywords = keywords;
        console.log(
            `[RAG Pipeline] Query rewritten into ${queries.length} variations with ${keywords.length} keywords`,
        );
    } else {
        console.log(
            "[RAG Pipeline] Query rewriting disabled, using original query",
        );
    }

    // Step 3: Hybrid search
    const topK = config.topK || RAG_CONFIG.TOP_K;
    const searchResult = await hybridSearch(queries, keywords, agentId, topK);

    debugInfo.vectorResultsCount = searchResult.vectorCount;
    debugInfo.ftsResultsCount = searchResult.ftsCount;

    // Step 4: Reranking (if enabled)
    let topMatches = searchResult.results.slice(0, 20); // Candidates for reranking
    debugInfo.rerankEnabled = config.rerank;

    if (config.rerank && topMatches.length > 0) {
        const rerankModelId = config.rerankModel || DEFAULT_MODELS.RERANKER;
        debugInfo.rerankModel = rerankModelId;

        topMatches = await rerankResults(
            userQuery,
            topMatches,
            topK,
            rerankModelId,
        );
    } else if (topMatches.length > 0) {
        // No reranking, just take top results
        topMatches = topMatches.slice(0, topK);
    }

    // Step 5: Fetch full text from database to avoid Vectorize metadata truncation
    if (topMatches.length > 0) {
        topMatches = await enrichWithFullText(topMatches);
    }

    // Step 6: Build result
    if (topMatches.length === 0) {
        console.log("[RAG Pipeline] No relevant chunks found");
        return { context: null, debugInfo };
    }

    console.log(`[RAG Pipeline] Retrieved ${topMatches.length} chunks`);
    if (config.rerank) {
        console.log(
            `[RAG Pipeline] Score range: ${topMatches[0].score.toFixed(3)} to ${topMatches[topMatches.length - 1].score.toFixed(3)}`,
        );
    }

    // Build context
    const context: RAGContext = {
        chunks: topMatches.map((match) => {
            const metadata = match.metadata as MatchMetadata;
            return {
                content: String(match.content),
                sourceId: metadata?.sourceId || match.id,
                score: match.score,
                metadata: match.metadata,
            };
        }),
    };

    // Build debug info chunks
    debugInfo.chunks = topMatches.map((match) => {
        const metadata = match.metadata as MatchMetadata;
        return {
            id: match.id,
            content: String(match.content),
            score: match.score,
            sourceId: metadata?.sourceId || match.id,
            metadata: match.metadata || {},
        };
    });

    return { context, debugInfo };
}

/**
 * Enrich search results with full text and source metadata from database
 * This avoids truncation from Vectorize metadata limits and ensures fileName is available
 */
async function enrichWithFullText(
    matches: HybridSearchResult[],
): Promise<HybridSearchResult[]> {
    try {
        const chunkIds = matches.map((m) => m.id);

        // Fetch chunks with their source information (including fileName)
        const dbChunks = await db
            .select({
                id: documentChunks.id,
                text: documentChunks.text,
                documentId: documentChunks.documentId,
            })
            .from(documentChunks)
            .where(inArray(documentChunks.id, chunkIds));

        // Get unique source IDs and fetch their filenames
        const sourceIds = [...new Set(dbChunks.map((c) => c.documentId))];
        const sources = await db
            .select({
                id: knowledgeSource.id,
                fileName: knowledgeSource.fileName,
            })
            .from(knowledgeSource)
            .where(inArray(knowledgeSource.id, sourceIds));

        const sourceMap = new Map(sources.map((s) => [s.id, s.fileName]));
        const dbChunkMap = new Map(dbChunks.map((c) => [c.id, { text: c.text, documentId: c.documentId }]));

        let replacedCount = 0;
        const enrichedMatches = matches.map((match) => {
            const chunkData = dbChunkMap.get(match.id);
            if (chunkData) {
                const fullText = chunkData.text;
                const fileName = sourceMap.get(chunkData.documentId) || "Unknown source";
                const textReplaced = fullText && fullText.length > String(match.content).length;

                if (textReplaced) {
                    replacedCount++;
                }

                return {
                    ...match,
                    content: textReplaced ? fullText : match.content,
                    metadata: {
                        ...match.metadata,
                        contentLength: textReplaced ? fullText.length : String(match.content).length,
                        fileName,
                        sourceId: chunkData.documentId,
                    },
                };
            }
            return match;
        });

        if (replacedCount > 0) {
            console.log(
                `[RAG Pipeline] Replaced ${replacedCount} chunks with full text from DB`,
            );
        }

        return enrichedMatches;
    } catch (error) {
        console.warn(
            "[RAG Pipeline] Failed to fetch full text from DB, using search results:",
            error,
        );
        return matches;
    }
}

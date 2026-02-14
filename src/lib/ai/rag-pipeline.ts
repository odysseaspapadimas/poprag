/**
 * RAG Pipeline Module
 * Handles the retrieval-augmented generation flow:
 * - Intent classification
 * - Query rewriting
 * - Hybrid search (vector + FTS)
 * - Result fusion and reranking
 */

import type { LanguageModel } from "ai";
import { generateText } from "ai";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { documentChunks, knowledgeSource } from "@/db/schema";
import { reciprocalRankFusion } from "../utils";
import { DEFAULT_MODELS, RAG_CONFIG } from "./constants";
import {
  findRelevantContentWithEmbedding,
  generateEmbeddings,
  rerank,
  searchDocumentChunksFTS,
} from "./embedding";
import { resolveAndCreateModel } from "./helpers";

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────

/** A simplified message from conversation history used for CQR */
export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface RAGConfig {
  enabled: boolean;
  contextualEmbeddingsEnabled?: boolean;
  skipIntentClassification?: boolean;
  rewriteQuery: boolean;
  rewriteModel?: string;
  intentModel?: string;
  queryVariationsCount?: number;
  rerank: boolean;
  rerankModel?: string;
  topK?: number;
  minSimilarity?: number;
}

export interface RAGDebugInfo {
  enabled: boolean;
  contextualEmbeddingsEnabled?: boolean;
  skippedByIntent?: boolean;
  intentReason?: string;
  originalQuery?: string;
  /** The reformulated standalone query produced by CQR (only set when CQR ran) */
  reformulatedQuery?: string;
  /** Whether CQR was applied (conversation had prior turns) */
  cqrApplied?: boolean;
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
    vectorScore?: number; // Original vector similarity score (0-1)
    rerankScore?: number; // Reranker cross-encoder score
    sourceId?: string;
    metadata?: Record<string, unknown>;
  }>;
  // Timing metrics (in milliseconds)
  timing?: {
    conversationalReformulationMs?: number;
    intentClassificationMs?: number;
    queryRewriteMs?: number;
    vectorSearchMs?: number;
    ftsSearchMs?: number;
    hybridSearchMs?: number;
    rerankMs?: number;
    enrichmentMs?: number;
    totalRagMs?: number;
  };
  // Model information
  models?: {
    conversationalReformulationModel?: string;
    intentModel?: string;
    rewriteModel?: string;
    rerankModel?: string;
    chatModel?: string;
    chatProvider?: string;
  };
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
  chunkIndex?: number;
  documentId?: string;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────
// Conversational Query Reformulation (CQR)
// ─────────────────────────────────────────────────────

/** Maximum number of prior messages to include as conversation context */
const CQR_MAX_HISTORY_MESSAGES = 5;

/** Maximum characters per message in the conversation context */
const CQR_MAX_MESSAGE_LENGTH = 200;

/**
 * Reformulate a follow-up question into a standalone search query using
 * conversation history context.
 *
 * This resolves pronouns ("it", "that", "there"), references ("the second one"),
 * and ellipsis ("what about Q2?") so the RAG pipeline can retrieve relevant
 * content without needing conversation state.
 *
 * Standard CQR / "condense question" pattern used by LangChain, LlamaIndex,
 * and production RAG systems (Perplexity, Bing Chat).
 *
 * @returns The standalone query and whether reformulation actually occurred
 */
export async function reformulateConversationalQuery(
  model: LanguageModel,
  userQuery: string,
  conversationHistory: ConversationMessage[],
): Promise<{ reformulatedQuery: string; wasReformulated: boolean }> {
  // Only reformulate if there's meaningful prior conversation
  if (conversationHistory.length === 0) {
    return { reformulatedQuery: userQuery, wasReformulated: false };
  }

  // Take the last N messages, truncate long content
  const recentHistory = conversationHistory
    .slice(-CQR_MAX_HISTORY_MESSAGES)
    .map((msg) => {
      const truncated =
        msg.content.length > CQR_MAX_MESSAGE_LENGTH
          ? `${msg.content.slice(0, CQR_MAX_MESSAGE_LENGTH)}...`
          : msg.content;
      return `${msg.role === "user" ? "User" : "Assistant"}: ${truncated}`;
    })
    .join("\n");

  try {
    const { text } = await generateText({
      model,
      prompt: `Given the following conversation and a follow-up message, rewrite the follow-up message as a standalone search query that captures the full intent without needing conversation context.

Rules:
- Resolve all pronouns (it, that, they, there, etc.) and references to specific entities from the conversation
- If the follow-up is already a standalone query with no references to the conversation, return it unchanged
- Output ONLY the reformulated query, nothing else — no explanation, no quotes, no prefix

Conversation:
${recentHistory}

Follow-up message: ${userQuery}

Standalone query:`,
      temperature: 0,
      maxOutputTokens: 100,
      abortSignal: AbortSignal.timeout(2000),
    });

    const reformulated = text.trim();

    // Sanity check: if the LLM returned empty or something suspiciously long, fall back
    if (!reformulated || reformulated.length > userQuery.length * 3) {
      console.warn(
        "[CQR] Reformulated query failed sanity check, using original",
      );
      return { reformulatedQuery: userQuery, wasReformulated: false };
    }

    const wasReformulated = reformulated !== userQuery;

    console.log(
      `[CQR] Original: "${userQuery.substring(0, 60)}${userQuery.length > 60 ? "..." : ""}"`,
    );
    if (wasReformulated) {
      console.log(
        `[CQR] Reformulated: "${reformulated.substring(0, 60)}${reformulated.length > 60 ? "..." : ""}"`,
      );
    } else {
      console.log("[CQR] Query unchanged (already standalone)");
    }

    return { reformulatedQuery: reformulated, wasReformulated };
  } catch (error) {
    console.warn("[CQR] Reformulation failed, using original query:", error);
    return { reformulatedQuery: userQuery, wasReformulated: false };
  }
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
    const { text } = await generateText({
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

User message: "${query}"

Respond ONLY with valid JSON in this exact format:
{"requiresRAG": true/false, "reason": "your explanation"}`,
      temperature: 0,
      maxOutputTokens: 120,
      abortSignal: AbortSignal.timeout(2000),
    });

    // Parse JSON response — strip markdown code fences that smaller models often add
    const jsonStr = text
      .trim()
      .replace(/^```(?:json)?\s*\n?/i, "")
      .replace(/\n?\s*```$/i, "");
    const parsed = JSON.parse(jsonStr);
    const output = {
      requiresRAG: Boolean(parsed.requiresRAG),
      reason: String(parsed.reason || "No reason provided"),
    };

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
  const trimmedQuery = query.trim();
  const wordCount = trimmedQuery ? trimmedQuery.split(/\s+/).length : 0;

  if (wordCount > 0 && wordCount <= 3) {
    return {
      queries: [query],
      keywords: trimmedQuery.split(/\s+/).slice(0, 3),
    };
  }

  const maxOutputTokens = Math.min(256, 60 + variationsCount * 40);
  const promptText = `Rewrite this user message into ${variationsCount} distinct search queries (each under 12 words) and extract up to 6 keywords.

User message: ${query}

Respond ONLY with JSON: {"queries": ["q1", "q2", "q3"], "keywords": ["k1", "k2"]}`;

  try {
    const { text } = await generateText({
      model,
      prompt: promptText,
      temperature: 0.2,
      maxOutputTokens,
      abortSignal: AbortSignal.timeout(2000), // 2s hard cap — falls back to original query on timeout
    });

    // Parse JSON response — strip markdown code fences that smaller models often add
    const jsonStr = text
      .trim()
      .replace(/^```(?:json)?\s*\n?/i, "")
      .replace(/\n?\s*```$/i, "");
    const parsed = JSON.parse(jsonStr);
    const output = {
      queries: Array.isArray(parsed.queries) ? parsed.queries : [query],
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
    };

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
  vectorScore?: number; // Original vector similarity score (undefined for FTS results)
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
  minSimilarity: number = RAG_CONFIG.MIN_SIMILARITY,
): Promise<{
  results: HybridSearchResult[];
  vectorCount: number;
  ftsCount: number;
  timing: {
    vectorSearchMs: number;
    ftsSearchMs: number;
  };
}> {
  const cleanedQueries = queries.map((query) => query.trim()).filter(Boolean);
  if (cleanedQueries.length === 0) {
    return {
      results: [],
      vectorCount: 0,
      ftsCount: 0,
      timing: {
        vectorSearchMs: 0,
        ftsSearchMs: 0,
      },
    };
  }

  // Optimize topK per query variation - fewer results per query, rely on fusion/reranking
  const topKPerQuery = Math.max(3, Math.ceil(topK / cleanedQueries.length));

  // Step 1: Perform vector search for all query variations
  const vectorSearchStart = Date.now();
  const queryEmbeddings = await generateEmbeddings(cleanedQueries);
  const vectorSearchPromises = queryEmbeddings.map((embedding, index) =>
    findRelevantContentWithEmbedding(
      cleanedQueries[index],
      embedding,
      agentId,
      {
        topK: topKPerQuery,
        minSimilarity: minSimilarity / 100, // Convert percentage to 0-1
      },
    ),
  );

  const vectorResults = await Promise.all(vectorSearchPromises);
  const vectorSearchMs = Date.now() - vectorSearchStart;

  const totalVectorResults = vectorResults.reduce(
    (sum, r) => sum + r.matches.length,
    0,
  );

  console.log(
    `[Hybrid Search] Vector search: ${totalVectorResults} results (${topKPerQuery} per query) in ${vectorSearchMs}ms`,
  );

  // Step 2: Always run FTS when keywords are available
  // FTS adds ~5-15ms latency but improves recall by surfacing exact keyword matches
  // that vector search may miss. The cost is negligible compared to the accuracy benefit.
  let ftsResults: Array<{ id: string; text: string; rank: number }> = [];
  let ftsSearchMs = 0;

  if (keywords.length > 0) {
    const ftsSearchStart = Date.now();
    try {
      ftsResults = await searchDocumentChunksFTS(keywords, agentId, {
        limit: topKPerQuery,
      });
      ftsSearchMs = Date.now() - ftsSearchStart;
      console.log(
        `[Hybrid Search] FTS search: ${ftsResults.length} results in ${ftsSearchMs}ms`,
      );
    } catch (_error) {
      ftsSearchMs = Date.now() - ftsSearchStart;
      console.warn("[Hybrid Search] FTS unavailable, using vector search only");
    }

    if (ftsResults.length === 0) {
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
    vectorScore: undefined, // FTS results don't have vector scores
    metadata: {},
  }));

  // Merge all result sets (vector results already have vectorScore from findRelevantContent)
  const allResultSets = [...vectorResults.map((r) => r.matches), ftsMatches];

  // reciprocalRankFusion only uses id and score, vectorScore is preserved through the process
  const fusedResults = reciprocalRankFusion(
    allResultSets as Array<Array<{ id: string; score: number }>>,
    RAG_CONFIG.RRF_K,
  ) as HybridSearchResult[];

  // Return more candidates for reranking (2x topK instead of 3x for speed)
  return {
    results: fusedResults.slice(0, topK * 2),
    vectorCount: totalVectorResults,
    ftsCount: ftsResults.length,
    timing: {
      vectorSearchMs,
      ftsSearchMs,
    },
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

  // Create a map to preserve original vector scores
  const vectorScoreMap = new Map(candidates.map((c) => [c.id, c.vectorScore]));

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
    score: r.score, // This is now the reranker score
    vectorScore: vectorScoreMap.get(r.id), // Preserve original vector score
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
 * @param userQuery - The user's latest query
 * @param agentId - The agent ID for namespace isolation
 * @param config - RAG configuration from agent settings
 * @param conversationHistory - Prior conversation messages for CQR (optional)
 * @returns RAG context and debug info
 */
export async function performRAGRetrieval(
  userQuery: string,
  agentId: string,
  config: RAGConfig,
  conversationHistory?: ConversationMessage[],
): Promise<RAGResult> {
  const ragStartTime = Date.now();
  const debugInfo: RAGDebugInfo = {
    enabled: config.enabled,
    contextualEmbeddingsEnabled: config.contextualEmbeddingsEnabled ?? false,
    timing: {},
    models: {},
  };

  // Early return if RAG is disabled
  if (!config.enabled) {
    return { context: null, debugInfo };
  }

  // Validate query
  if (!userQuery || userQuery.trim().length === 0) {
    return { context: null, debugInfo };
  }

  debugInfo.originalQuery = userQuery;

  // Step 0: Conversational Query Reformulation (CQR)
  // Resolves pronouns and references in follow-up questions using conversation history
  let effectiveQuery = userQuery;
  if (conversationHistory && conversationHistory.length > 0) {
    const cqrModelId = DEFAULT_MODELS.CONVERSATIONAL_REFORMULATION;
    debugInfo.models!.conversationalReformulationModel = cqrModelId;

    const cqrStart = Date.now();
    const cqrModel = await resolveAndCreateModel(cqrModelId);
    const cqrResult = await reformulateConversationalQuery(
      cqrModel,
      userQuery,
      conversationHistory,
    );
    debugInfo.timing!.conversationalReformulationMs = Date.now() - cqrStart;
    debugInfo.cqrApplied = cqrResult.wasReformulated;

    if (cqrResult.wasReformulated) {
      effectiveQuery = cqrResult.reformulatedQuery;
      debugInfo.reformulatedQuery = effectiveQuery;
      console.log(
        `[RAG Pipeline] CQR reformulated query in ${debugInfo.timing!.conversationalReformulationMs}ms`,
      );
    } else {
      console.log(
        `[RAG Pipeline] CQR: query unchanged (${debugInfo.timing!.conversationalReformulationMs}ms)`,
      );
    }
  }

  const rewriteModelId = config.rewriteModel || DEFAULT_MODELS.QUERY_REWRITE;
  const variationsCount = config.queryVariationsCount || 3;

  let queries = [effectiveQuery];
  let keywords: string[] = [];

  if (config.skipIntentClassification) {
    console.log("[RAG Pipeline] Intent classification skipped by config");
    debugInfo.skippedByIntent = false;

    if (config.rewriteQuery) {
      debugInfo.models!.rewriteModel = rewriteModelId;
      const rewriteStart = Date.now();
      const model = await resolveAndCreateModel(rewriteModelId);
      const rewriteResult = await rewriteQuery(
        model,
        effectiveQuery,
        variationsCount,
      );
      debugInfo.timing!.queryRewriteMs = Date.now() - rewriteStart;
      queries = rewriteResult.queries;
      keywords = rewriteResult.keywords;
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
  } else {
    const intentModelId =
      config.intentModel || DEFAULT_MODELS.INTENT_CLASSIFICATION;

    debugInfo.models!.intentModel = intentModelId;
    if (config.rewriteQuery) {
      debugInfo.models!.rewriteModel = rewriteModelId;
    }

    const intentStart = Date.now();
    const intentPromise = resolveAndCreateModel(intentModelId).then((model) =>
      classifyQueryIntent(model, effectiveQuery),
    );

    const rewriteStart = Date.now();
    const rewritePromise = config.rewriteQuery
      ? resolveAndCreateModel(rewriteModelId).then((model) =>
          rewriteQuery(model, effectiveQuery, variationsCount),
        )
      : Promise.resolve({
          queries: [effectiveQuery],
          keywords: [] as string[],
        });

    const [intentResult, rewriteResult] = await Promise.all([
      intentPromise.then((result) => {
        debugInfo.timing!.intentClassificationMs = Date.now() - intentStart;
        return result;
      }),
      rewritePromise.then((result) => {
        if (config.rewriteQuery) {
          debugInfo.timing!.queryRewriteMs = Date.now() - rewriteStart;
        }
        return result;
      }),
    ]);

    if (!intentResult.requiresRAG) {
      console.log(
        `[RAG Pipeline] Skipping RAG - query classified as not requiring knowledge: ${intentResult.reason}`,
      );
      debugInfo.skippedByIntent = true;
      debugInfo.intentReason = intentResult.reason;
      debugInfo.timing!.totalRagMs = Date.now() - ragStartTime;
      return { context: null, debugInfo };
    }

    queries = rewriteResult.queries;
    keywords = rewriteResult.keywords;

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
  }

  // Step 3: Hybrid search (uses platform-wide embedding model)
  const topK = config.topK || RAG_CONFIG.TOP_K;
  const minSimilarity = config.minSimilarity ?? RAG_CONFIG.MIN_SIMILARITY;
  const hybridSearchStart = Date.now();
  const searchResult = await hybridSearch(
    queries,
    keywords,
    agentId,
    topK,
    minSimilarity,
  );
  debugInfo.timing!.hybridSearchMs = Date.now() - hybridSearchStart;
  debugInfo.timing!.vectorSearchMs = searchResult.timing.vectorSearchMs;
  debugInfo.timing!.ftsSearchMs = searchResult.timing.ftsSearchMs;

  debugInfo.vectorResultsCount = searchResult.vectorCount;
  debugInfo.ftsResultsCount = searchResult.ftsCount;

  // Step 4: Reranking (if enabled)
  let topMatches = searchResult.results.slice(0, 20); // Candidates for reranking
  debugInfo.rerankEnabled = config.rerank;

  if (config.rerank && topMatches.length > 0) {
    const rerankModelId = config.rerankModel || DEFAULT_MODELS.RERANKER;
    debugInfo.rerankModel = rerankModelId;
    debugInfo.models!.rerankModel = rerankModelId;

    const rerankStart = Date.now();
    topMatches = await rerankResults(
      effectiveQuery,
      topMatches,
      topK,
      rerankModelId,
    );
    debugInfo.timing!.rerankMs = Date.now() - rerankStart;
  } else if (topMatches.length > 0) {
    // No reranking, just take top results
    topMatches = topMatches.slice(0, topK);
  }

  // Step 5: Fetch full text from database to avoid Vectorize metadata truncation
  if (topMatches.length > 0) {
    const enrichmentStart = Date.now();
    topMatches = await enrichWithFullText(topMatches);
    topMatches = await expandWithNeighborChunks(topMatches, topK);
    debugInfo.timing!.enrichmentMs = Date.now() - enrichmentStart;
  }

  // Step 6: Build result
  if (topMatches.length === 0) {
    console.log("[RAG Pipeline] No relevant chunks found");
    debugInfo.timing!.totalRagMs = Date.now() - ragStartTime;
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
      vectorScore: match.vectorScore, // Original vector similarity (if available)
      rerankScore: config.rerank ? match.score : undefined, // Reranker score (if reranking was used)
      sourceId: metadata?.sourceId || match.id,
      metadata: match.metadata || {},
    };
  });

  // Record total RAG time
  debugInfo.timing!.totalRagMs = Date.now() - ragStartTime;
  console.log(
    `[RAG Pipeline] Total RAG time: ${debugInfo.timing!.totalRagMs}ms`,
  );

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

    // Single JOIN query: fetch chunk text + source fileName in one D1 round-trip
    const dbRows = await db
      .select({
        id: documentChunks.id,
        text: documentChunks.text,
        documentId: documentChunks.documentId,
        chunkIndex: documentChunks.chunkIndex,
        fileName: knowledgeSource.fileName,
      })
      .from(documentChunks)
      .innerJoin(
        knowledgeSource,
        eq(documentChunks.documentId, knowledgeSource.id),
      )
      .where(inArray(documentChunks.id, chunkIds));

    const dbRowMap = new Map(dbRows.map((r) => [r.id, r]));

    let replacedCount = 0;
    const enrichedMatches = matches.map((match) => {
      const row = dbRowMap.get(match.id);
      if (row) {
        const fullText = row.text;
        const fileName = row.fileName || "Unknown source";
        const textReplaced =
          fullText && fullText.length > String(match.content).length;

        if (textReplaced) {
          replacedCount++;
        }

        return {
          ...match,
          content: textReplaced ? fullText : match.content,
          metadata: {
            ...match.metadata,
            contentLength: textReplaced
              ? fullText.length
              : String(match.content).length,
            fileName,
            sourceId: row.documentId,
            documentId: row.documentId,
            chunkIndex: row.chunkIndex,
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

/**
 * Expand results with adjacent chunks to avoid mid-sentence cutoffs
 */
async function expandWithNeighborChunks(
  matches: HybridSearchResult[],
  topK: number,
): Promise<HybridSearchResult[]> {
  const baseMatches = matches.filter(
    (match) =>
      match.metadata?.sourceId && match.metadata?.chunkIndex !== undefined,
  );

  if (baseMatches.length === 0) return matches;

  type NeighborKey = `${string}:${number}`;
  const baseByKey = new Map<NeighborKey, HybridSearchResult>();
  const neighborTargetSet = new Set<NeighborKey>();
  const neighborTargets: Array<{ documentId: string; chunkIndex: number }> = [];

  baseMatches.forEach((match) => {
    const metadata = match.metadata as MatchMetadata;
    const documentId = metadata.documentId || metadata.sourceId;
    const chunkIndex = metadata.chunkIndex;

    if (!documentId || chunkIndex === undefined || chunkIndex === null) return;

    baseByKey.set(`${documentId}:${chunkIndex}`, match);

    const prevKey: NeighborKey = `${documentId}:${chunkIndex - 1}`;
    const nextKey: NeighborKey = `${documentId}:${chunkIndex + 1}`;

    if (chunkIndex > 0 && !neighborTargetSet.has(prevKey)) {
      neighborTargetSet.add(prevKey);
      neighborTargets.push({ documentId, chunkIndex: chunkIndex - 1 });
    }
    if (!neighborTargetSet.has(nextKey)) {
      neighborTargetSet.add(nextKey);
      neighborTargets.push({ documentId, chunkIndex: chunkIndex + 1 });
    }
  });

  if (neighborTargets.length === 0) return matches;

  // Group neighbor targets by documentId to build efficient queries:
  // SELECT ... WHERE documentId IN (...) AND chunkIndex IN (...)
  // Then filter in JS. This avoids N individual OR(AND(...)) conditions.
  const byDocument = new Map<string, number[]>();
  for (const t of neighborTargets) {
    const existing = byDocument.get(t.documentId);
    if (existing) {
      existing.push(t.chunkIndex);
    } else {
      byDocument.set(t.documentId, [t.chunkIndex]);
    }
  }

  const docIds = [...byDocument.keys()];
  const allChunkIndices = [
    ...new Set(neighborTargets.map((t) => t.chunkIndex)),
  ];

  // Single query: fetch all candidate rows, then filter in JS
  const candidateRows = await db
    .select({
      id: documentChunks.id,
      text: documentChunks.text,
      documentId: documentChunks.documentId,
      chunkIndex: documentChunks.chunkIndex,
    })
    .from(documentChunks)
    .where(
      and(
        inArray(documentChunks.documentId, docIds),
        inArray(documentChunks.chunkIndex, allChunkIndices),
      ),
    );

  // Filter to only the exact (documentId, chunkIndex) pairs we need
  const neighborRows = candidateRows.filter((row) =>
    neighborTargetSet.has(`${row.documentId}:${row.chunkIndex}`),
  );

  if (neighborRows.length === 0) return matches;

  const existingIds = new Set(matches.map((m) => m.id));
  const neighborMatches: HybridSearchResult[] = neighborRows
    .filter((row) => !existingIds.has(row.id))
    .map((row) => {
      const prevKey = `${row.documentId}:${row.chunkIndex + 1}` as NeighborKey;
      const nextKey = `${row.documentId}:${row.chunkIndex - 1}` as NeighborKey;
      const baseMatch = baseByKey.get(prevKey) || baseByKey.get(nextKey);
      const baseScore = baseMatch?.score ?? 0;

      return {
        id: row.id,
        content: row.text,
        score: baseScore * 0.9,
        vectorScore: baseMatch?.vectorScore,
        metadata: {
          ...baseMatch?.metadata,
          sourceId: row.documentId,
          documentId: row.documentId,
          chunkIndex: row.chunkIndex,
          contentLength: row.text.length,
          neighborOf: baseMatch?.id,
        },
      };
    });

  const merged = [...matches, ...neighborMatches];

  return merged.slice(0, Math.max(topK * 2, topK + 2));
}

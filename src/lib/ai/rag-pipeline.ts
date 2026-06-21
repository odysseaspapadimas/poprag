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
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import {
  catalogConfig,
  catalogProduct,
  documentChunks,
  knowledgeSource,
} from "@/db/schema";
import type {
  CatalogExactMatch,
  CatalogFieldCapability,
  CatalogListContinuationState,
  CatalogStructuredFilter,
  CatalogStructuredIntent,
  CatalogStructuredLookupIntent,
  CatalogStructuredQueryResult,
} from "@/lib/catalog/query";
import { reciprocalRankFusion } from "../utils";
import { DEFAULT_MODELS, RAG_CONFIG } from "./constants";
import {
  findRelevantContentWithEmbedding,
  generateEmbeddings,
  rerank,
  searchDocumentChunksFTS,
  type VectorSearchDiagnostics,
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
  skipIntentClassification?: boolean;
  rewriteQuery: boolean;
  rewriteModel?: string;
  intentModel?: string;
  queryVariationsCount?: number;
  rerank: boolean;
  rerankModel?: string;
  topK?: number;
  minSimilarity?: number;
  /** When set, restrict RAG to these knowledge source IDs (experience filtering) */
  experienceKnowledgeIds?: string[];
}

export interface RAGDebugInfo {
  enabled: boolean;
  skippedByIntent?: boolean;
  intentReason?: string;
  originalQuery?: string;
  /** The reformulated standalone query produced by CQR (only set when CQR ran) */
  reformulatedQuery?: string;
  /** Whether CQR was applied (conversation had prior turns) */
  cqrApplied?: boolean;
  /** Whether CQR was attempted but failed (e.g. timeout) */
  cqrFailed?: boolean;
  /** Whether image context extraction was attempted and succeeded */
  imageContextExtracted?: boolean;
  /** Description extracted from image by vision model (used to enhance RAG query) */
  imageDescription?: string;
  rewrittenQueries?: string[];
  keywords?: string[];
  vectorResultsCount?: number;
  ftsResultsCount?: number;
  vectorSearchMode?:
    | "unfiltered"
    | "direct_filtered_query"
    | "broad_namespace_query"
    | "broad_query_plus_app_filter";
  vectorFilterCapability?: "unknown" | "available" | "unavailable";
  vectorFilterApplied?: boolean;
  vectorFilterReason?: string;
  vectorFallbackTopK?: number;
  catalogStructuredIntent?: CatalogStructuredIntent | "none";
  catalogStructuredIntentReason?: string;
  catalogStructuredFilters?: CatalogStructuredFilter[];
  catalogActiveProductCount?: number;
  catalogStructuredMatchedProducts?: number;
  catalogStructuredProductsReturned?: number;
  catalogStructuredContinuationOf?: "list" | "filter";
  catalogStructuredOffset?: number;
  catalogStructuredLimit?: number;
  catalogStructuredNextOffset?: number;
  catalogStructuredHasMore?: boolean;
  catalogStructuredComplete?: boolean;
  catalogExactMatchCount?: number;
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
    imageContextExtractionMs?: number;
    conversationalReformulationMs?: number;
    intentClassificationMs?: number;
    queryRewriteMs?: number;
    vectorSearchMs?: number;
    ftsSearchMs?: number;
    hybridSearchMs?: number;
    catalogStructuredIntentMs?: number;
    catalogStructuredQueryMs?: number;
    catalogExactSearchMs?: number;
    rerankMs?: number;
    enrichmentMs?: number;
    totalRagMs?: number;
  };
  // Model information
  models?: {
    imageContextModel?: string;
    conversationalReformulationModel?: string;
    intentModel?: string;
    catalogStructuredIntentModel?: string;
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

export interface CatalogRetrievalLane {
  loadCapabilities(options: {
    agentId: string;
    knowledgeSourceIds?: string[];
  }): Promise<{
    activeProductCount: number;
    fieldCapabilities: CatalogFieldCapability[];
  }>;
  findStructuredQueryResult(options: {
    intent: CatalogStructuredLookupIntent;
    agentId: string;
    knowledgeSourceIds?: string[];
    filters?: CatalogStructuredFilter[];
    limit?: number;
    offset?: number;
    totalActiveProducts?: number;
    fieldCapabilities?: CatalogFieldCapability[];
  }): Promise<CatalogStructuredQueryResult | null>;
  findExactMatches(options: {
    query: string;
    agentId: string;
    knowledgeSourceIds?: string[];
    limit?: number;
  }): Promise<CatalogExactMatch[]>;
}

interface MatchMetadata {
  sourceId?: string;
  chunkIndex?: number;
  documentId?: string;
  productId?: string;
  catalogProduct?: boolean;
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
 * @returns The standalone query, whether reformulation occurred, and whether it failed
 */
export async function reformulateConversationalQuery(
  model: LanguageModel,
  userQuery: string,
  conversationHistory: ConversationMessage[],
): Promise<{
  reformulatedQuery: string;
  wasReformulated: boolean;
  failed?: boolean;
}> {
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
- IMPORTANT: Preserve the original language of the query. If the user writes in Greek, output in Greek. Never translate.
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

    // Sanity check: if the LLM returned empty or something suspiciously long, fall back.
    // Use a minimum floor (150 chars) so short follow-ups like "ingredient list?"
    // can expand to include entity names from conversation context.
    const maxReformulatedLength = Math.max(150, userQuery.length * 3);
    if (!reformulated) {
      console.warn("[CQR] Reformulated query is empty, using original");
      return { reformulatedQuery: userQuery, wasReformulated: false };
    }
    if (reformulated.length > maxReformulatedLength) {
      console.warn(
        `[CQR] Reformulated query too long (${reformulated.length} > ${maxReformulatedLength}), using original`,
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
    const isTimeout =
      error instanceof DOMException && error.name === "AbortError";
    console.warn(
      `[CQR] Reformulation ${isTimeout ? "timed out" : "failed"}, using original query:`,
      error,
    );
    return {
      reformulatedQuery: userQuery,
      wasReformulated: false,
      failed: true,
    };
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

interface CatalogRetrievalPlan {
  intent: CatalogStructuredIntent | "none";
  reason: string;
  filters: CatalogStructuredFilter[];
}

export async function planCatalogStructuredRetrieval(
  model: LanguageModel,
  options: {
    query: string;
    originalQuery?: string;
    previousCatalogPage?: CatalogListContinuationState;
    activeCatalogProductCount: number;
    fieldCapabilities: CatalogFieldCapability[];
  },
): Promise<CatalogRetrievalPlan> {
  const previousPageJson = options.previousCatalogPage
    ? JSON.stringify({
        intent: options.previousCatalogPage.intent,
        filters: options.previousCatalogPage.filters,
        offset: options.previousCatalogPage.offset,
        limit: options.previousCatalogPage.limit,
        nextOffset: options.previousCatalogPage.nextOffset,
        hasMore: options.previousCatalogPage.hasMore,
      })
    : "null";

  const capabilitySummary = summarizeCatalogFieldCapabilities(
    options.fieldCapabilities,
  );

  try {
    const { text } = await generateText({
      model,
      prompt: `You are a router for a product catalog RAG system. You are not answering the user.
Decide whether the current user message should use the structured catalog inventory layer before normal vector/FTS retrieval.

The user may write in any language, including Greek. Preserve the user's language in extracted filters.

Active catalog products: ${options.activeCatalogProductCount}
Configured catalog filter fields JSON: ${JSON.stringify(capabilitySummary.filterFields)}
Catalog lookup fields JSON: ${JSON.stringify(capabilitySummary.lookupFields)}
Catalog searchable fields JSON: ${JSON.stringify(capabilitySummary.searchableFields)}
Previous catalog page state JSON: ${previousPageJson}
The previous page state is the last structured catalog answer in this conversation. If it is not null and hasMore=true, the assistant can continue from nextOffset with the same list/filter.
Current user message JSON: ${JSON.stringify(options.originalQuery ?? options.query)}
Reformulated search query JSON: ${JSON.stringify(options.query)}

Choose exactly one intent:
- "count": the user asks for the total number of products/items/SKUs available in the catalog.
- "list": the user asks for a broad inventory list of products the catalog has/carries/offers, without filters.
- "filter": the user asks for products matching a brand, category, type, keyword, product line, SKU-like value, barcode-like value, or other catalog subset.
- "continue_list": the user is continuing/paginating the previous catalog inventory list.
- "capabilities": the user asks what filters, fields, or ways of narrowing/searching the catalog are available.
- "none": the message should not use structured inventory lookup.

Conversation-state rule:
If previous catalog page state is not null, hasMore=true, and the current user message is a reply that accepts, confirms, asks for more, asks for the next page, or otherwise continues the previous list, choose "continue_list". This includes very short replies in any language (for example affirmative-only replies) when they clearly refer to the assistant's previous offer to continue.
Do not choose "continue_list" when previous catalog page state is null or hasMore=false.

Return "none" for:
- specific product detail questions such as ingredients, dimensions, warnings, price, usage, nutrition, or barcode details
- recommendations or comparisons
- general small talk unrelated to catalog inventory
- ambiguous messages that do not clearly refer to inventory or the previous catalog page

For intent="filter", extract the shortest useful filter terms in the original language. Keep brand/category/product words as written. Do not include generic words like products, items, catalog, have, carry, show, list, which, ποια, έχετε, προϊόντα unless they are part of a product name.
When the user asks about available filters, base the answer on configured catalog filter fields. Lookup/searchable fields can be mentioned as lookup/search options, but they are not configured filters.

Respond ONLY with valid JSON in this exact shape:
{"intent":"count"|"list"|"filter"|"continue_list"|"capabilities"|"none","filters":["term"],"reason":"short explanation"}`,
      temperature: 0,
      maxOutputTokens: 220,
      abortSignal: AbortSignal.timeout(1800),
    });

    const jsonStr = text
      .trim()
      .replace(/^```(?:json)?\s*\n?/i, "")
      .replace(/\n?\s*```$/i, "");
    const parsed = JSON.parse(jsonStr);
    const intent =
      parsed.intent === "count" ||
      parsed.intent === "list" ||
      parsed.intent === "filter" ||
      parsed.intent === "continue_list" ||
      parsed.intent === "capabilities"
        ? parsed.intent
        : "none";
    const filters = Array.isArray(parsed.filters)
      ? parsed.filters
          .map((value: unknown) => String(value || "").trim())
          .filter(Boolean)
          .slice(0, 6)
          .map((value: string) => ({ value }))
      : [];

    return {
      intent,
      filters: intent === "filter" ? filters : [],
      reason: String(parsed.reason || "No reason provided"),
    };
  } catch (error) {
    console.warn(
      "[Catalog Structured Planner] Planning failed, using normal RAG:",
      error,
    );
    return {
      intent: "none",
      filters: [],
      reason: "Catalog planning failed, using normal RAG",
    };
  }
}

function summarizeCatalogFieldCapabilities(
  capabilities: CatalogFieldCapability[],
): {
  filterFields: string[];
  lookupFields: string[];
  searchableFields: string[];
} {
  const fieldsByRole = (roles: CatalogFieldCapability["role"][]) => {
    const roleSet = new Set(roles);
    return Array.from(
      new Set(
        capabilities
          .filter((capability) => roleSet.has(capability.role))
          .map((capability) => capability.fieldPath.trim())
          .filter(Boolean),
      ),
    );
  };

  return {
    filterFields: fieldsByRole(["filterable"]),
    lookupFields: fieldsByRole(["stable_key", "title", "exact"]),
    searchableFields: fieldsByRole(["searchable"]),
  };
}

function resolveCatalogStructuredLookup(
  intent: CatalogStructuredIntent | "none",
  filters: CatalogStructuredFilter[],
  previousCatalogPage: CatalogListContinuationState | undefined,
  defaultLimit: number,
): {
  intent: CatalogStructuredLookupIntent;
  filters: CatalogStructuredFilter[];
  offset: number;
  limit: number;
} | null {
  if (intent === "none") return null;

  if (intent === "continue_list") {
    if (!previousCatalogPage) return null;
    return {
      intent: previousCatalogPage.intent,
      filters: previousCatalogPage.filters,
      offset: previousCatalogPage.nextOffset,
      limit: previousCatalogPage.limit || defaultLimit,
    };
  }

  if (intent === "filter" && filters.length === 0) return null;

  return {
    intent,
    filters: intent === "filter" ? filters : [],
    offset: 0,
    limit: defaultLimit,
  };
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
IMPORTANT: Preserve the original language. If the message is in Greek, write queries and keywords in Greek. Never translate.

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
// Lightweight Keyword Extraction (no LLM)
// ─────────────────────────────────────────────────────

/**
 * Extract basic keywords from a query using simple tokenization.
 * Used as a fallback when query rewriting is disabled so that FTS
 * always has terms to search with.
 *
 * Strategy: split on whitespace/punctuation, keep tokens ≥ 3 chars,
 * deduplicate, sort by length descending (longer words are more
 * distinctive in any language), return up to `maxKeywords` terms.
 * Works with any language (Greek, English, etc.) since it relies
 * on Unicode word boundaries, not a language-specific stemmer.
 */
function extractBasicKeywords(
  query: string,
  maxKeywords: number = 10,
): string[] {
  const normalizeKeyword = (token: string) =>
    token
      .normalize("NFD")
      .replace(/\p{M}+/gu, "")
      .replace(/ς/g, "σ")
      .toLowerCase();

  // Split on whitespace + common punctuation, keep Unicode word chars
  const tokens = query
    .split(/[\s,;:!?()[\]{}"«»\-–—]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3); // Drop very short words (articles, etc.)

  // Deduplicate case-insensitively, preserve original casing of first occurrence
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const token of tokens) {
    const normalized = normalizeKeyword(token);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      unique.push(token);
    }
  }

  // Sort by length descending — longer words are more distinctive and
  // produce better FTS results than short common function words
  unique.sort((a, b) => b.length - a.length);

  return unique.slice(0, maxKeywords);
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
  experienceKnowledgeIds?: string[],
): Promise<{
  results: HybridSearchResult[];
  vectorCount: number;
  ftsCount: number;
  vectorDiagnostics?: VectorSearchDiagnostics;
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
      vectorDiagnostics: undefined,
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
        knowledgeSourceIds: experienceKnowledgeIds,
      },
    ),
  );

  const vectorResults = await Promise.all(vectorSearchPromises);
  const vectorSearchMs = Date.now() - vectorSearchStart;

  if (experienceKnowledgeIds && experienceKnowledgeIds.length > 0) {
    console.log(
      `[Hybrid Search] Scoped vector search to experience knowledge sources (${experienceKnowledgeIds.length} allowed)`,
    );
  }

  const totalVectorResults = vectorResults.reduce(
    (sum, r) => sum + r.matches.length,
    0,
  );
  const vectorDiagnostics = vectorResults[0]?.diagnostics;

  console.log(
    `[Hybrid Search] Vector search: ${totalVectorResults} results (${topKPerQuery} per query) in ${vectorSearchMs}ms`,
  );

  if (vectorDiagnostics) {
    console.log(
      `[Hybrid Search] Vector retrieval mode: ${vectorDiagnostics.retrievalMode}` +
        (vectorDiagnostics.filterRequested
          ? ` (filter capability: ${vectorDiagnostics.filterCapability})`
          : ""),
    );
  }

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
        knowledgeSourceIds: experienceKnowledgeIds,
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
    score: r.rank,
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
    vectorDiagnostics,
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
  previousCatalogPage?: CatalogListContinuationState,
  catalogLane?: CatalogRetrievalLane,
): Promise<RAGResult> {
  const ragStartTime = Date.now();
  const debugInfo: RAGDebugInfo = {
    enabled: config.enabled,
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
    debugInfo.cqrFailed = cqrResult.failed ?? false;

    if (cqrResult.failed) {
      console.warn(
        `[RAG Pipeline] CQR failed after ${debugInfo.timing!.conversationalReformulationMs}ms, proceeding with original query`,
      );
    } else if (cqrResult.wasReformulated) {
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
  const topK = config.topK || RAG_CONFIG.TOP_K;
  const minSimilarity = config.minSimilarity ?? RAG_CONFIG.MIN_SIMILARITY;

  let queries = [effectiveQuery];
  let keywords: string[] = [];

  const catalogStructuredQueryStart = Date.now();
  const catalogCapabilities = catalogLane
    ? await catalogLane.loadCapabilities({
        agentId,
        knowledgeSourceIds: config.experienceKnowledgeIds,
      })
    : { activeProductCount: 0, fieldCapabilities: [] };
  const activeCatalogProductCount = catalogCapabilities.activeProductCount;
  const catalogFieldCapabilities = catalogCapabilities.fieldCapabilities;
  debugInfo.timing!.catalogStructuredQueryMs =
    Date.now() - catalogStructuredQueryStart;
  debugInfo.catalogActiveProductCount = activeCatalogProductCount;

  if (catalogLane && activeCatalogProductCount > 0) {
    const catalogPlannerModelId =
      config.intentModel || DEFAULT_MODELS.INTENT_CLASSIFICATION;
    debugInfo.models!.catalogStructuredIntentModel = catalogPlannerModelId;

    const catalogStructuredIntentStart = Date.now();
    const catalogPlannerModel = await resolveAndCreateModel(
      catalogPlannerModelId,
    );
    const catalogPlan = await planCatalogStructuredRetrieval(
      catalogPlannerModel,
      {
        query: effectiveQuery,
        originalQuery: userQuery,
        previousCatalogPage,
        activeCatalogProductCount,
        fieldCapabilities: catalogFieldCapabilities,
      },
    );
    debugInfo.timing!.catalogStructuredIntentMs =
      Date.now() - catalogStructuredIntentStart;
    debugInfo.catalogStructuredIntent = catalogPlan.intent;
    debugInfo.catalogStructuredIntentReason = catalogPlan.reason;
    debugInfo.catalogStructuredFilters = catalogPlan.filters;

    const lookup = resolveCatalogStructuredLookup(
      catalogPlan.intent,
      catalogPlan.filters,
      previousCatalogPage,
      Math.max(20, topK),
    );

    if (lookup) {
      const structuredLookupStart = Date.now();
      const structuredCatalogResult =
        await catalogLane.findStructuredQueryResult({
          intent: lookup.intent,
          agentId,
          knowledgeSourceIds: config.experienceKnowledgeIds,
          filters: lookup.filters,
          limit: lookup.limit,
          offset: lookup.offset,
          totalActiveProducts: activeCatalogProductCount,
          fieldCapabilities: catalogFieldCapabilities,
        });
      debugInfo.timing!.catalogStructuredQueryMs =
        (debugInfo.timing!.catalogStructuredQueryMs ?? 0) +
        (Date.now() - structuredLookupStart);

      if (structuredCatalogResult) {
        const match = structuredCatalogResult.match;
        debugInfo.catalogActiveProductCount =
          structuredCatalogResult.totalActiveProducts;
        debugInfo.catalogStructuredMatchedProducts =
          structuredCatalogResult.matchedProducts;
        debugInfo.catalogStructuredProductsReturned =
          structuredCatalogResult.returnedProducts;
        debugInfo.catalogStructuredFilters = structuredCatalogResult.filters;
        debugInfo.catalogStructuredContinuationOf =
          catalogPlan.intent === "continue_list" &&
          (structuredCatalogResult.intent === "list" ||
            structuredCatalogResult.intent === "filter")
            ? structuredCatalogResult.intent
            : undefined;
        debugInfo.catalogStructuredOffset = structuredCatalogResult.offset;
        debugInfo.catalogStructuredLimit = structuredCatalogResult.limit;
        debugInfo.catalogStructuredNextOffset =
          structuredCatalogResult.nextOffset;
        debugInfo.catalogStructuredHasMore = structuredCatalogResult.hasMore;
        debugInfo.catalogStructuredComplete = structuredCatalogResult.complete;
        debugInfo.catalogExactMatchCount = 0;
        debugInfo.vectorResultsCount = 0;
        debugInfo.ftsResultsCount = 0;
        debugInfo.rerankEnabled = false;
        debugInfo.timing!.totalRagMs = Date.now() - ragStartTime;

        debugInfo.chunks = [
          {
            id: match.id,
            content: match.content,
            score: match.score,
            vectorScore: match.vectorScore,
            sourceId: String(match.metadata.sourceId ?? match.id),
            metadata: match.metadata,
          },
        ];

        return {
          context: {
            chunks: [
              {
                content: match.content,
                sourceId: String(match.metadata.sourceId ?? match.id),
                score: match.score,
                metadata: match.metadata,
              },
            ],
          },
          debugInfo,
        };
      }
    }
  }

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

  // Fallback keyword extraction: when query rewriting is disabled (or failed),
  // keywords[] is empty and FTS never runs. Extract basic keywords from the
  // effective query so FTS always participates in hybrid search.
  if (keywords.length === 0) {
    keywords = extractBasicKeywords(effectiveQuery);
    if (keywords.length > 0) {
      debugInfo.keywords = keywords;
      console.log(
        `[RAG Pipeline] Extracted ${keywords.length} fallback keywords for FTS: ${keywords.join(", ")}`,
      );
    }
  }

  // Step 3: Hybrid search (uses platform-wide embedding model)
  const catalogExactSearchStart = Date.now();
  const catalogExactMatches =
    catalogLane && activeCatalogProductCount > 0
      ? await catalogLane.findExactMatches({
          query: effectiveQuery,
          agentId,
          knowledgeSourceIds: config.experienceKnowledgeIds,
          limit: topK,
        })
      : [];
  debugInfo.timing!.catalogExactSearchMs = Date.now() - catalogExactSearchStart;
  debugInfo.catalogExactMatchCount = catalogExactMatches.length;

  if (catalogExactMatches.length > 0) {
    console.log(
      `[RAG Pipeline] Catalog exact lookup returned ${catalogExactMatches.length} product match(es)`,
    );
  }

  const hybridSearchStart = Date.now();
  const searchResult = await hybridSearch(
    queries,
    keywords,
    agentId,
    topK,
    minSimilarity,
    config.experienceKnowledgeIds,
  );
  debugInfo.timing!.hybridSearchMs = Date.now() - hybridSearchStart;
  debugInfo.timing!.vectorSearchMs = searchResult.timing.vectorSearchMs;
  debugInfo.timing!.ftsSearchMs = searchResult.timing.ftsSearchMs;

  debugInfo.vectorResultsCount = searchResult.vectorCount;
  debugInfo.ftsResultsCount = searchResult.ftsCount;
  debugInfo.vectorSearchMode = searchResult.vectorDiagnostics?.retrievalMode;
  debugInfo.vectorFilterCapability =
    searchResult.vectorDiagnostics?.filterCapability;
  debugInfo.vectorFilterApplied = searchResult.vectorDiagnostics?.filterApplied;
  debugInfo.vectorFilterReason = searchResult.vectorDiagnostics?.filterReason;
  debugInfo.vectorFallbackTopK = searchResult.vectorDiagnostics?.fallbackTopK;

  if (searchResult.vectorDiagnostics) {
    console.log(
      `[RAG Pipeline] Final vector candidates came from ${searchResult.vectorDiagnostics.retrievalMode}`,
    );
  }

  // Step 4: Enrich with full text from D1 BEFORE reranking
  // Vector results have empty content (Vectorize metadata no longer stores text)
  // The reranker needs actual text content to score, so enrichment must come first
  const exactIds = new Set(catalogExactMatches.map((match) => match.id));
  let topMatches = [
    ...catalogExactMatches,
    ...searchResult.results.filter((match) => !exactIds.has(match.id)),
  ].slice(0, 20); // Candidates for reranking
  debugInfo.rerankEnabled = config.rerank;

  if (topMatches.length > 0) {
    const enrichmentStart = Date.now();
    topMatches = await enrichWithFullText(topMatches);
    debugInfo.timing!.enrichmentMs = Date.now() - enrichmentStart;
  }

  // Step 5: Reranking (if enabled) — now has full text from D1
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

  if (catalogExactMatches.length > 0) {
    const currentIds = new Set(catalogExactMatches.map((match) => match.id));
    topMatches = [
      ...catalogExactMatches,
      ...topMatches.filter((match) => !currentIds.has(match.id)),
    ].slice(0, topK);
  }

  // Step 6: Expand with neighbor chunks
  if (topMatches.length > 0) {
    const neighborStart = Date.now();
    topMatches = await expandWithNeighborChunks(topMatches, topK);
    // Include neighbor expansion time in enrichment timing
    debugInfo.timing!.enrichmentMs =
      (debugInfo.timing!.enrichmentMs || 0) + (Date.now() - neighborStart);
  }

  // Step 7: Filter out empty-content chunks
  // Chunks may have empty content if D1 enrichment failed (DB error, orphaned Vectorize entry)
  // Empty strings waste context slots and confuse the model
  const preFilterCount = topMatches.length;
  topMatches = topMatches.filter(
    (m) => typeof m.content === "string" && m.content.trim().length > 0,
  );
  if (preFilterCount !== topMatches.length) {
    console.warn(
      `[RAG Pipeline] Filtered out ${preFilterCount - topMatches.length} empty-content chunks`,
    );
  }

  // Step 8: Build result
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
 * Vectorize metadata no longer stores chunk text — D1 is the sole source of truth
 * This function is called BEFORE reranking so the reranker has actual text to score
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
        productId: documentChunks.productId,
        recordKey: documentChunks.recordKey,
        chunkMetadata: documentChunks.metadata,
        fileName: knowledgeSource.fileName,
      })
      .from(documentChunks)
      .innerJoin(
        knowledgeSource,
        eq(documentChunks.documentId, knowledgeSource.id),
      )
      .leftJoin(catalogProduct, eq(catalogProduct.id, documentChunks.productId))
      .leftJoin(
        catalogConfig,
        eq(catalogConfig.knowledgeSourceId, documentChunks.documentId),
      )
      .where(
        and(
          inArray(documentChunks.id, chunkIds),
          or(
            and(
              isNull(documentChunks.productId),
              eq(knowledgeSource.status, "indexed"),
            ),
            and(
              eq(catalogConfig.enabled, true),
              eq(catalogProduct.status, "active"),
              eq(catalogProduct.indexVersion, catalogConfig.activeIndexVersion),
            ),
          ),
        ),
      );

    const dbRowMap = new Map(dbRows.map((r) => [r.id, r]));

    let enrichedCount = 0;
    let missingCount = 0;
    const enrichedMatches: HybridSearchResult[] = [];

    for (const match of matches) {
      const row = dbRowMap.get(match.id);
      if (row) {
        enrichedCount++;
        enrichedMatches.push({
          ...match,
          content: row.text,
          metadata: {
            ...match.metadata,
            contentLength: row.text.length,
            fileName: row.fileName || "Unknown source",
            sourceId: row.documentId,
            documentId: row.documentId,
            chunkIndex: row.chunkIndex,
            productId: row.productId,
            recordKey: row.recordKey,
            ...(row.chunkMetadata ?? {}),
          },
        });
        continue;
      }

      missingCount++;
      console.warn(
        `[RAG Pipeline] Chunk ${match.id} not found in indexed D1 sources (orphaned or in-progress Vectorize entry?)`,
      );
    }

    console.log(
      `[RAG Pipeline] Enriched ${enrichedCount}/${matches.length} chunks with text from DB${missingCount > 0 ? ` (${missingCount} missing)` : ""}`,
    );

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
  const neighborEligibleMatches = baseMatches.filter(
    (match) => !match.metadata?.catalogProduct && !match.metadata?.productId,
  );

  if (neighborEligibleMatches.length === 0) return matches;

  type NeighborKey = `${string}:${number}`;
  const baseByKey = new Map<NeighborKey, HybridSearchResult>();
  const neighborTargetSet = new Set<NeighborKey>();
  const neighborTargets: Array<{ documentId: string; chunkIndex: number }> = [];

  neighborEligibleMatches.forEach((match) => {
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
    .innerJoin(
      knowledgeSource,
      eq(documentChunks.documentId, knowledgeSource.id),
    )
    .leftJoin(catalogProduct, eq(catalogProduct.id, documentChunks.productId))
    .leftJoin(
      catalogConfig,
      eq(catalogConfig.knowledgeSourceId, documentChunks.documentId),
    )
    .where(
      and(
        inArray(documentChunks.documentId, docIds),
        inArray(documentChunks.chunkIndex, allChunkIndices),
        or(
          and(
            isNull(documentChunks.productId),
            eq(knowledgeSource.status, "indexed"),
          ),
          and(
            eq(catalogConfig.enabled, true),
            eq(catalogProduct.status, "active"),
            eq(catalogProduct.indexVersion, catalogConfig.activeIndexVersion),
          ),
        ),
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

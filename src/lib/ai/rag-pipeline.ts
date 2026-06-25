/**
 * RAG Pipeline Module
 * Handles the retrieval-augmented generation flow:
 * - Intent classification
 * - Query rewriting
 * - Hybrid search (vector + FTS)
 * - Result fusion and reranking
 */

import { env } from "cloudflare:workers";
import type { LanguageModel } from "ai";
import { generateText } from "ai";
import { executeCatalogPlan } from "@/lib/retrieval/catalog-evidence-store";
import {
  makeCatalogFocus,
  makeCatalogPageCursor,
  makeCatalogProductFocus,
} from "@/lib/retrieval/catalog-page-state";
import { retrieveDocumentEvidence } from "@/lib/retrieval/document-evidence-store";
import { planRetrieval } from "@/lib/retrieval/retrieval-planner";
import { loadSourceCapabilities } from "@/lib/retrieval/source-capability-index";
import type {
  CatalogEvidence,
  CatalogPageAction,
  CatalogProductResolutionDiagnostics,
  CatalogSearchMode,
  CatalogSearchTerm,
  RetrievalCatalogFocus,
  RetrievalCatalogProductFocus,
  RetrievalPageCursor,
  RetrievalPlanKind,
} from "@/lib/retrieval/types";
import { DEFAULT_MODELS, RAG_CONFIG } from "./constants";
import { resolveAndCreateModel, resolveModelConfig } from "./helpers";
import type { ModelConfig } from "./models";

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
  retrievalPlanKind?: RetrievalPlanKind;
  retrievalPlanReason?: string;
  retrievalPlannerFallbackReason?: string;
  retrievalPlannerRawText?: string;
  catalogAvailable?: boolean;
  documentAvailable?: boolean;
  catalogActiveProductCount?: number;
  catalogScopes?: Array<{
    sourceId: string;
    name?: string | null;
    aliases: string[];
  }>;
  catalogEvidenceKind?: CatalogEvidence["kind"];
  catalogValidationResult?: string;
  catalogValidationError?: string;
  catalogTerms?: CatalogSearchTerm[];
  catalogMatchedProducts?: number;
  catalogProductsReturned?: number;
  catalogSearchMode?: CatalogSearchMode;
  catalogPageAction?: CatalogPageAction;
  catalogProductResolutions?: CatalogProductResolutionDiagnostics[];
  catalogPageOffset?: number;
  catalogPageLimit?: number;
  catalogPageNextOffset?: number;
  catalogPageHasMore?: boolean;
  catalogPageCursor?: RetrievalPageCursor;
  catalogFocus?: RetrievalCatalogFocus;
  catalogProductFocus?: RetrievalCatalogProductFocus;
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
    sourceCapabilityMs?: number;
    retrievalPlannerMs?: number;
    catalogEvidenceMs?: number;
    rerankMs?: number;
    enrichmentMs?: number;
    totalRagMs?: number;
  };
  // Model information
  models?: {
    imageContextModel?: string;
    conversationalReformulationModel?: string;
    intentModel?: string;
    retrievalPlannerModel?: string;
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
  catalogEvidence?: CatalogEvidence;
  debugInfo: RAGDebugInfo;
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

type PlannerTextRequest = {
  prompt: string;
  temperature: number;
  maxOutputTokens: number;
  abortSignal: AbortSignal;
};

function isWorkersAIGlmPlannerModel(config: ModelConfig): boolean {
  return (
    config.provider === "cloudflare-workers-ai" &&
    config.modelId === "@cf/zai-org/glm-4.7-flash"
  );
}

async function generateWorkersAIGlmPlannerText(
  modelId: string,
  request: PlannerTextRequest,
): Promise<string> {
  if (!env.AI) {
    throw new Error("Workers AI requires AI binding");
  }

  const ai = env.AI as {
    run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
  };

  const output = await rejectOnAbort(
    ai.run(modelId, {
      messages: [{ role: "user", content: request.prompt }],
      max_tokens: request.maxOutputTokens,
      temperature: request.temperature,
      reasoning_effort: null,
      chat_template_kwargs: {
        enable_thinking: false,
        clear_thinking: true,
      },
    }),
    request.abortSignal,
  );

  return extractWorkersAIText(output);
}

function rejectOnAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });

    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function extractWorkersAIText(output: unknown): string {
  if (typeof output === "string") return output;

  const response = output as {
    response?: unknown;
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const text = response.choices?.[0]?.message?.content ?? response.response;

  if (typeof text === "string") return text;
  if (text && typeof text === "object") return JSON.stringify(text);

  throw new Error("Workers AI planner returned no text");
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
  previousCatalogPage?: RetrievalPageCursor,
  previousCatalogFocus?: RetrievalCatalogFocus,
  previousCatalogProductFocus?: RetrievalCatalogProductFocus,
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

  const sourceCapabilityStart = Date.now();
  const sourceCapabilities = await loadSourceCapabilities({
    agentId,
    knowledgeSourceIds: config.experienceKnowledgeIds,
  });
  debugInfo.timing!.sourceCapabilityMs = Date.now() - sourceCapabilityStart;
  debugInfo.catalogAvailable = sourceCapabilities.catalog.available;
  debugInfo.documentAvailable = sourceCapabilities.documents.available;
  debugInfo.catalogActiveProductCount =
    sourceCapabilities.catalog.activeProductCount;
  debugInfo.catalogScopes = sourceCapabilities.catalog.scopes;

  const retrievalPlannerModelId =
    config.intentModel || DEFAULT_MODELS.RETRIEVAL_PLANNER;
  debugInfo.models!.retrievalPlannerModel = retrievalPlannerModelId;
  const retrievalPlannerStart = Date.now();
  const retrievalPlannerModelConfig = await resolveModelConfig(
    retrievalPlannerModelId,
  );
  const directWorkersAIGlmPlanner = isWorkersAIGlmPlannerModel(
    retrievalPlannerModelConfig,
  );
  const retrievalPlannerModel = directWorkersAIGlmPlanner
    ? null
    : await resolveAndCreateModel(retrievalPlannerModelId);
  const { plan: retrievalPlan, diagnostics: plannerDiagnostics } =
    await planRetrieval(retrievalPlannerModel, {
      modelId: retrievalPlannerModelId,
      userMessage: userQuery,
      effectiveQuery,
      capabilities: sourceCapabilities,
      previousCatalogPage,
      previousCatalogFocus,
      previousCatalogProductFocus,
      generatePlannerText: directWorkersAIGlmPlanner
        ? (request) =>
            generateWorkersAIGlmPlannerText(
              retrievalPlannerModelConfig.modelId,
              request,
            )
        : undefined,
    });
  debugInfo.timing!.retrievalPlannerMs = Date.now() - retrievalPlannerStart;
  debugInfo.retrievalPlanKind = plannerDiagnostics.planKind;
  debugInfo.retrievalPlanReason = plannerDiagnostics.reason;
  debugInfo.retrievalPlannerFallbackReason = plannerDiagnostics.fallbackReason;
  debugInfo.retrievalPlannerRawText = plannerDiagnostics.rawText;

  const catalogEvidenceStart = Date.now();
  const { evidence: catalogEvidence, diagnostics: catalogDiagnostics } =
    await executeCatalogPlan({
      plan: retrievalPlan,
      capabilities: sourceCapabilities,
      previousCatalogPage,
      defaultLimit: Math.max(20, config.topK || RAG_CONFIG.TOP_K),
    });
  debugInfo.timing!.catalogEvidenceMs = Date.now() - catalogEvidenceStart;
  debugInfo.catalogEvidenceKind = catalogEvidence?.kind;
  debugInfo.catalogValidationResult = catalogDiagnostics.validationResult;
  debugInfo.catalogValidationError = catalogDiagnostics.errorCode;
  debugInfo.catalogMatchedProducts = catalogDiagnostics.matchedProducts;
  debugInfo.catalogProductsReturned = catalogDiagnostics.returnedProducts;
  debugInfo.catalogSearchMode = catalogDiagnostics.searchMode;
  debugInfo.catalogPageAction = catalogDiagnostics.pageAction;
  debugInfo.catalogProductResolutions = catalogDiagnostics.productResolutions;
  debugInfo.catalogPageOffset = catalogDiagnostics.offset;
  debugInfo.catalogPageLimit = catalogDiagnostics.limit;
  debugInfo.catalogPageNextOffset = catalogDiagnostics.nextOffset;
  debugInfo.catalogPageHasMore = catalogDiagnostics.hasMore;
  if (
    catalogEvidence?.kind === "product_page" ||
    catalogEvidence?.kind === "count" ||
    catalogEvidence?.kind === "no_match"
  ) {
    debugInfo.catalogTerms = catalogEvidence.terms;
  }
  debugInfo.catalogPageCursor = makeCatalogPageCursor(catalogEvidence);
  debugInfo.catalogFocus = makeCatalogFocus(catalogEvidence);
  debugInfo.catalogProductFocus = makeCatalogProductFocus(catalogEvidence);

  if (retrievalPlan.kind === "none") {
    debugInfo.skippedByIntent = true;
    debugInfo.intentReason = retrievalPlan.reason;
    debugInfo.timing!.totalRagMs = Date.now() - ragStartTime;
    return { context: null, catalogEvidence, debugInfo };
  }

  const isCatalogOnlyPlan =
    retrievalPlan.kind.startsWith("catalog_") &&
    retrievalPlan.kind !== "catalog_continue";
  const isCatalogContinuation = retrievalPlan.kind === "catalog_continue";
  const shouldRetrieveDocuments =
    retrievalPlan.kind === "document_retrieval" ||
    retrievalPlan.kind === "mixed";

  if ((isCatalogOnlyPlan || isCatalogContinuation) && catalogEvidence) {
    debugInfo.vectorResultsCount = 0;
    debugInfo.ftsResultsCount = 0;
    debugInfo.rerankEnabled = false;
    debugInfo.timing!.totalRagMs = Date.now() - ragStartTime;
    return { context: null, catalogEvidence, debugInfo };
  }

  if (!shouldRetrieveDocuments && !sourceCapabilities.documents.available) {
    debugInfo.timing!.totalRagMs = Date.now() - ragStartTime;
    return { context: null, catalogEvidence, debugInfo };
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
      return { context: null, catalogEvidence, debugInfo };
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

  const topK = config.topK || RAG_CONFIG.TOP_K;
  const minSimilarity = config.minSimilarity ?? RAG_CONFIG.MIN_SIMILARITY;
  const documentResult = await retrieveDocumentEvidence({
    query: effectiveQuery,
    queries,
    keywords,
    agentId,
    topK,
    minSimilarity,
    knowledgeSourceIds: config.experienceKnowledgeIds,
    includeCatalogProductChunks: !plannerDiagnostics.fallbackReason,
    rerank: config.rerank,
    rerankModel: config.rerankModel,
  });
  const documentDiagnostics = documentResult.diagnostics;
  debugInfo.keywords = documentDiagnostics.keywords;
  debugInfo.vectorResultsCount = documentDiagnostics.vectorResultsCount;
  debugInfo.ftsResultsCount = documentDiagnostics.ftsResultsCount;
  debugInfo.vectorSearchMode = documentDiagnostics.vectorSearchMode;
  debugInfo.vectorFilterCapability = documentDiagnostics.vectorFilterCapability;
  debugInfo.vectorFilterApplied = documentDiagnostics.vectorFilterApplied;
  debugInfo.vectorFilterReason = documentDiagnostics.vectorFilterReason;
  debugInfo.vectorFallbackTopK = documentDiagnostics.vectorFallbackTopK;
  debugInfo.rerankEnabled = documentDiagnostics.rerankEnabled;
  debugInfo.rerankModel = documentDiagnostics.rerankModel;
  if (documentDiagnostics.rerankModel) {
    debugInfo.models!.rerankModel = documentDiagnostics.rerankModel;
  }
  debugInfo.timing!.hybridSearchMs = documentDiagnostics.timing.hybridSearchMs;
  debugInfo.timing!.vectorSearchMs = documentDiagnostics.timing.vectorSearchMs;
  debugInfo.timing!.ftsSearchMs = documentDiagnostics.timing.ftsSearchMs;
  debugInfo.timing!.rerankMs = documentDiagnostics.timing.rerankMs;
  debugInfo.timing!.enrichmentMs = documentDiagnostics.timing.enrichmentMs;
  debugInfo.chunks = documentDiagnostics.chunks;

  if (!documentResult.evidence) {
    debugInfo.timing!.totalRagMs = Date.now() - ragStartTime;
    return { context: null, catalogEvidence, debugInfo };
  }

  const context: RAGContext = documentResult.evidence;
  debugInfo.timing!.totalRagMs = Date.now() - ragStartTime;
  console.log(
    `[RAG Pipeline] Total RAG time: ${debugInfo.timing!.totalRagMs}ms`,
  );

  return { context, catalogEvidence, debugInfo };
}

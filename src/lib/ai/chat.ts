/**
 * Runtime chat API endpoint
 * Implements the RAG-powered chat flow following AI SDK cookbook pattern
 *
 * This module has been refactored to use extracted helpers:
 * - constants.ts: Default model IDs and configuration
 * - helpers.ts: Model resolution and capability checking
 * - rag-pipeline.ts: RAG retrieval flow (intent, rewrite, search, rerank)
 * - image-service.ts: Image fetching and processing
 */

import type { StepResult, ToolSet, UIMessage } from "ai";
import { convertToModelMessages, streamText } from "ai";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/db";
import {
  type Agent,
  agent,
  agentExperience,
  agentExperienceKnowledge,
  agentModelPolicy,
  modelAlias,
  prompt,
  promptVersion,
  runMetric,
  transcript,
} from "@/db/schema";
import { createModel, type ProviderType } from "@/lib/ai/models";
import { renderPrompt } from "@/lib/ai/prompt";
import { buildRetrievalSystemPrompt } from "@/lib/retrieval/answer-composer";
import type {
  CatalogProductFocusItem,
  CatalogSearchTerm,
  RetrievalCatalogFocus,
  RetrievalCatalogProductFocus,
  RetrievalPageCursor,
} from "@/lib/retrieval/types";

// Import refactored modules
import type { ModelCapabilities } from "./helpers";
import { supportsModality } from "./helpers";
import {
  extractImageContextForRAG,
  isImagePart,
  processMessageParts,
} from "./image-service";
import {
  type ConversationMessage,
  performRAGRetrieval,
  type RAGConfig,
  type RAGDebugInfo,
} from "./rag-pipeline";

// Re-export functions for backwards compatibility
export { classifyQueryIntent, rewriteQuery } from "./rag-pipeline";

export interface ChatRequest {
  agentSlug: string;
  experienceSlug?: string | null; // Filter RAG to specific experience
  messages: UIMessage[];
  modelAlias?: string;
  variables?: Record<string, unknown>;
  rag?: {
    enabled?: boolean;
    topK?: number;
    filters?: Record<string, unknown>;
    rewriteQuery?: boolean;
    rewriteModel?: string;
    rerank?: boolean;
    rerankModel?: string;
  };
  conversationId?: string;
  initiatedBy?: string;
  firebaseUid?: string; // Firebase user ID from verified token
  languageInstruction?: string; // Explicit language instruction for Flutter app
}

/**
 * Handle chat request with RAG
 * Refactored to use extracted helper modules for better maintainability
 *
 * @param waitUntil - Cloudflare Workers waitUntil to extend Worker lifetime
 *   for background DB writes (metrics/transcript) after the stream is sent.
 *   Without this, the Worker may be terminated before onFinish DB inserts
 *   complete, causing metrics to be silently dropped for external API clients
 *   (e.g. Flutter apps) that close the connection as soon as streaming ends.
 */
export async function handleChatRequest(
  request: ChatRequest,
  env: Env,
  waitUntil?: (promise: Promise<unknown>) => void,
) {
  const runId = nanoid();
  const startTime = Date.now();

  // Keep in outer scope for error metrics
  let agentData: Agent | undefined;
  let selectedAlias: string | undefined;
  let resolvedCapabilities: ModelCapabilities | null = null;

  try {
    // 1. Resolve agent first (needed for subsequent parallel queries)
    agentData = await resolveAgent(request.agentSlug);

    // 2. Load prompt config and model policy in PARALLEL for speed
    const [
      { basePrompt },
      policy,
      experienceKnowledgeIds,
      previousCatalogState,
    ] = await Promise.all([
      loadPromptConfig(agentData.id, request.variables),
      loadModelPolicy(agentData.id),
      resolveExperienceKnowledge(agentData.id, request.experienceSlug),
      loadLatestCatalogState(agentData.id, request.conversationId),
    ]);

    // 3. Resolve model and capabilities (before RAG, needed for image context extraction)
    const resolved = await resolveModelForChat(
      request.modelAlias || policy.modelAlias,
    );
    const resolvedAlias = resolved.selectedAlias;
    selectedAlias = resolvedAlias;
    resolvedCapabilities = resolved.capabilities;
    const { model, capabilities, provider } = resolved;

    // 4. Extract user query and enhance with image context if present
    let userQuery = extractUserQuery(request);
    const conversationHistory = extractConversationHistory(request);

    // 4b. Image context extraction: use the chat model (vision-capable) to extract
    // searchable text from images, so RAG can retrieve relevant knowledge.
    // Without this, queries like "analyze this image" produce irrelevant RAG results
    // because the image content is never used to inform retrieval.
    let imageDescription: string | null = null;
    let imageContextMs: number | undefined;
    const lastUserMessage = findLastUserMessage(request.messages);
    const hasImages =
      lastUserMessage?.parts.some((p: { type: string }) => isImagePart(p)) ??
      false;

    if (hasImages && supportsModality(capabilities, "image")) {
      const imageStart = Date.now();
      imageDescription = await extractImageContextForRAG(
        lastUserMessage!.parts,
        model,
        env,
      );
      imageContextMs = Date.now() - imageStart;

      if (imageDescription) {
        userQuery = `${imageDescription}. ${userQuery}`;
        console.log(
          `[Chat] Enhanced RAG query with image context (${imageContextMs}ms)`,
        );
      }
    }

    // 5. RAG retrieval (using extracted pipeline, with image-enhanced query)
    const ragConfig: RAGConfig = {
      enabled: agentData.ragEnabled,
      skipIntentClassification: agentData.skipIntentClassification ?? false,
      rewriteQuery: agentData.rewriteQuery,
      rewriteModel: agentData.rewriteModel || undefined,
      intentModel: agentData.intentModel || undefined,
      queryVariationsCount: agentData.queryVariationsCount || 3,
      rerank: agentData.rerank,
      rerankModel: agentData.rerankModel || undefined,
      topK: request.rag?.topK ?? agentData.topK ?? undefined,
      minSimilarity: agentData.minSimilarity ?? undefined,
      experienceKnowledgeIds,
    };

    const {
      context: ragContext,
      catalogEvidence,
      debugInfo: ragDebugInfo,
    } = await performRAGRetrieval(
      userQuery,
      agentData.id,
      ragConfig,
      conversationHistory,
      previousCatalogState.page,
      previousCatalogState.focus,
      previousCatalogState.productFocus,
    );

    // 5b. Add model and image context info to debug
    ragDebugInfo.models = {
      ...ragDebugInfo.models,
      chatModel: resolvedAlias,
      chatProvider: provider,
      ...(hasImages && { imageContextModel: resolvedAlias }),
    };
    if (hasImages) {
      ragDebugInfo.imageContextExtracted = !!imageDescription;
      if (imageDescription) ragDebugInfo.imageDescription = imageDescription;
      if (ragDebugInfo.timing) {
        ragDebugInfo.timing.imageContextExtractionMs = imageContextMs;
      }
    }

    // 6. Build final system prompt with RAG context
    let systemPrompt = buildRetrievalSystemPrompt(basePrompt, {
      catalogEvidence,
      documentEvidence: ragContext,
    });

    // 6b. Append language instruction if provided (for Flutter app)
    if (request.languageInstruction) {
      systemPrompt = `${systemPrompt}\n\n${request.languageInstruction}`;
    }

    // 7. Process messages (handle images based on model capabilities)
    const processedMessages = (await Promise.all(
      request.messages.map(async (msg) => ({
        ...msg,
        parts: await processMessageParts(
          msg.parts,
          capabilities,
          resolvedAlias,
          env,
        ),
      })),
    )) as UIMessage[];

    // 7. Convert to model messages
    const modelMessages = await convertToModelMessages(processedMessages);

    // 8. Stream response
    let firstTokenTime: number | undefined;

    // Reasoning models don't support temperature/topP — omit to avoid AI SDK warnings
    const isReasoningModel = capabilities?.reasoning === true;

    const result = streamText({
      model,
      system: systemPrompt,
      messages: modelMessages,
      ...(isReasoningModel
        ? {}
        : {
            temperature: policy.temperature || 0.7,
            topP: policy.topP || 1,
          }),
      maxOutputTokens: policy.maxTokens || 4096,
      onChunk: (event) => {
        if (!firstTokenTime && event.chunk.type === "text-delta") {
          firstTokenTime = Date.now();
        }
      },
      onFinish: async (event) => {
        const metricsPromise = saveTranscriptAndMetrics(
          agentData!,
          runId,
          request,
          ragDebugInfo,
          event,
          startTime,
          firstTokenTime,
          selectedAlias,
          resolvedCapabilities,
        );
        // Register with waitUntil so the Worker stays alive for DB writes
        // even after the streaming response has been fully sent to the client.
        if (waitUntil) {
          waitUntil(metricsPromise);
        } else {
          await metricsPromise;
        }
      },
    });

    return result;
  } catch (error) {
    const errorMetricPromise = saveErrorMetric(
      agentData,
      runId,
      startTime,
      error,
      request,
      selectedAlias,
    );
    if (waitUntil) {
      waitUntil(errorMetricPromise);
    } else {
      await errorMetricPromise;
    }
    throw error;
  }
}

// ─────────────────────────────────────────────────────
// Helper Functions (extracted from handleChatRequest)
// ─────────────────────────────────────────────────────

interface LatestCatalogState {
  page?: RetrievalPageCursor;
  focus?: RetrievalCatalogFocus;
  productFocus?: RetrievalCatalogProductFocus;
}

interface RagDebugCatalogState {
  retrievalPlanKind?: unknown;
  catalogEvidenceKind?: unknown;
  catalogTerms?: unknown;
  catalogMatchedProducts?: unknown;
  catalogPageCursor?: unknown;
  catalogFocus?: unknown;
  catalogProductFocus?: unknown;
}

async function loadLatestCatalogState(
  agentId: string,
  conversationId?: string,
): Promise<LatestCatalogState> {
  if (!conversationId) return {};

  const recentTranscripts = await db
    .select({ request: transcript.request })
    .from(transcript)
    .where(
      and(
        eq(transcript.agentId, agentId),
        eq(transcript.conversationId, conversationId),
      ),
    )
    .orderBy(desc(transcript.createdAt))
    .limit(5);

  for (const item of recentTranscripts) {
    const request = item.request as Record<string, unknown> | undefined;
    const ragDebug = request?.ragDebug as RagDebugCatalogState | undefined;
    if (!ragDebug) continue;

    const page = normalizeCatalogPageCursor(ragDebug.catalogPageCursor);
    const focus =
      normalizeCatalogFocus(ragDebug.catalogFocus) ??
      deriveCatalogFocusFromDebug(ragDebug);
    const productFocus = normalizeCatalogProductFocus(
      ragDebug.catalogProductFocus,
    );

    if (page || focus || productFocus) return { page, focus, productFocus };
    if (typeof ragDebug.catalogEvidenceKind === "string") return {};
  }

  return {};
}

function normalizeCatalogPageCursor(
  value: unknown,
): RetrievalPageCursor | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const cursor = value as Partial<RetrievalPageCursor>;
  if (cursor.kind !== "catalog_page" || cursor.planKind !== "catalog_search") {
    return undefined;
  }

  const terms = normalizeCatalogSearchTerms(cursor.terms);
  const scopeSourceIds = normalizeStringList(cursor.scopeSourceIds);

  return {
    kind: "catalog_page",
    planKind: "catalog_search",
    terms,
    scopeSourceIds: scopeSourceIds.length > 0 ? scopeSourceIds : undefined,
    offset: finiteNumber(cursor.offset) ?? 0,
    limit: finiteNumber(cursor.limit) ?? 20,
    nextOffset: finiteNumber(cursor.nextOffset) ?? 0,
    hasMore: cursor.hasMore === true,
  };
}

function normalizeCatalogFocus(
  value: unknown,
): RetrievalCatalogFocus | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const focus = value as Partial<RetrievalCatalogFocus>;
  if (focus.kind !== "catalog_focus") return undefined;
  if (
    focus.planKind !== "catalog_search" &&
    focus.planKind !== "catalog_count"
  ) {
    return undefined;
  }

  const terms = normalizeCatalogSearchTerms(focus.terms);
  const scopeSourceIds = normalizeStringList(focus.scopeSourceIds);
  if (terms.length === 0 && scopeSourceIds.length === 0) return undefined;

  return {
    kind: "catalog_focus",
    planKind: focus.planKind,
    terms,
    scopeSourceIds: scopeSourceIds.length > 0 ? scopeSourceIds : undefined,
    matchedProducts: finiteNumber(focus.matchedProducts) ?? 0,
  };
}

function normalizeCatalogProductFocus(
  value: unknown,
): RetrievalCatalogProductFocus | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const focus = value as Partial<RetrievalCatalogProductFocus>;
  if (focus.kind !== "catalog_product_focus") return undefined;

  const products = normalizeCatalogProductFocusItems(focus.products);
  if (products.length === 0) return undefined;

  return {
    kind: "catalog_product_focus",
    terms: normalizeCatalogSearchTerms(focus.terms),
    matchedProducts: finiteNumber(focus.matchedProducts) ?? products.length,
    products,
  };
}

function normalizeCatalogProductFocusItems(
  value: unknown,
): CatalogProductFocusItem[] {
  if (!Array.isArray(value)) return [];

  const products: CatalogProductFocusItem[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const product = item as Partial<CatalogProductFocusItem>;
    const productId = String(product.productId ?? "").trim();
    const title = String(product.title ?? "").trim();
    const recordKey = String(product.recordKey ?? "").trim();
    if (!productId || !title || !recordKey) continue;
    products.push({ productId, title, recordKey });
  }

  return products.slice(0, 20);
}

function deriveCatalogFocusFromDebug(
  ragDebug: RagDebugCatalogState,
): RetrievalCatalogFocus | undefined {
  const evidenceKind = ragDebug.catalogEvidenceKind;
  if (evidenceKind !== "product_page" && evidenceKind !== "count") {
    return undefined;
  }

  const terms = normalizeCatalogSearchTerms(ragDebug.catalogTerms);
  if (terms.length === 0) return undefined;

  return {
    kind: "catalog_focus",
    planKind: evidenceKind === "count" ? "catalog_count" : "catalog_search",
    terms,
    matchedProducts: finiteNumber(ragDebug.catalogMatchedProducts) ?? 0,
  };
}

function normalizeCatalogSearchTerms(value: unknown): CatalogSearchTerm[] {
  if (!Array.isArray(value)) return [];

  const terms: CatalogSearchTerm[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const term = item as Partial<CatalogSearchTerm>;
    const termValue = String(term.value ?? "").trim();
    if (!termValue) continue;

    const fieldPath =
      typeof term.fieldPath === "string"
        ? term.fieldPath.trim() || undefined
        : undefined;
    terms.push(
      fieldPath ? { value: termValue, fieldPath } : { value: termValue },
    );
  }

  return terms;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const items: string[] = [];
  for (const item of value) {
    const text = String(item ?? "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    items.push(text);
  }
  return items;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Resolve experience knowledge source IDs for filtering RAG queries.
 * Returns undefined when no experience is specified (search all knowledge).
 * Returns the list of knowledge source IDs assigned to the experience.
 */
async function resolveExperienceKnowledge(
  agentId: string,
  experienceSlug?: string | null,
): Promise<string[] | undefined> {
  if (!experienceSlug) return undefined;

  // Look up experience by agent + slug
  const [experience] = await db
    .select()
    .from(agentExperience)
    .where(
      and(
        eq(agentExperience.agentId, agentId),
        eq(agentExperience.slug, experienceSlug),
        eq(agentExperience.isActive, true),
      ),
    )
    .limit(1);

  if (!experience) {
    console.warn(
      `[Chat] Experience '${experienceSlug}' not found for agent '${agentId}', searching all knowledge`,
    );
    return undefined;
  }

  // Get assigned knowledge source IDs
  const knowledgeLinks = await db
    .select({ knowledgeSourceId: agentExperienceKnowledge.knowledgeSourceId })
    .from(agentExperienceKnowledge)
    .where(eq(agentExperienceKnowledge.experienceId, experience.id));

  const ids = knowledgeLinks.map((link) => link.knowledgeSourceId);

  if (ids.length === 0) {
    console.warn(
      `[Chat] Experience '${experienceSlug}' has no knowledge sources assigned`,
    );
    return undefined;
  }

  console.log(
    `[Chat] Experience '${experienceSlug}' resolved to ${ids.length} knowledge source(s)`,
  );
  return ids;
}

/**
 * Resolve agent by slug and validate it's active
 */
async function resolveAgent(slug: string): Promise<Agent> {
  const [resolvedAgent] = await db
    .select()
    .from(agent)
    .where(eq(agent.slug, slug))
    .limit(1);

  if (!resolvedAgent) {
    throw new Error(`Agent '${slug}' not found`);
  }

  if (resolvedAgent.status !== "active") {
    throw new Error(`Agent '${slug}' is not active`);
  }

  return resolvedAgent;
}

/**
 * Load prompt configuration for an agent
 */
async function loadPromptConfig(
  agentId: string,
  requestVariables?: Record<string, unknown>,
): Promise<{ basePrompt: string; mergedVariables: Record<string, unknown> }> {
  const [systemPromptData] = await db
    .select()
    .from(prompt)
    .where(and(eq(prompt.agentId, agentId), eq(prompt.key, "system")))
    .limit(1);

  if (!systemPromptData) {
    throw new Error("System prompt not found");
  }

  const [activePromptVersion] = await db
    .select()
    .from(promptVersion)
    .where(
      and(
        eq(promptVersion.promptId, systemPromptData.id),
        eq(promptVersion.label, "prod"),
      ),
    )
    .limit(1);

  if (!activePromptVersion) {
    throw new Error("No production prompt version found");
  }

  const mergedVariables = {
    ...activePromptVersion.variables,
    ...requestVariables,
  };

  const basePrompt = renderPrompt(activePromptVersion.content, mergedVariables);

  return { basePrompt, mergedVariables };
}

/**
 * Load model policy for an agent
 */
async function loadModelPolicy(agentId: string) {
  const [policy] = await db
    .select()
    .from(agentModelPolicy)
    .where(eq(agentModelPolicy.agentId, agentId))
    .orderBy(desc(agentModelPolicy.effectiveFrom))
    .limit(1);

  if (!policy) {
    throw new Error("No model policy found");
  }

  return policy;
}

/**
 * Extract user query from request
 */
function extractUserQuery(request: ChatRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const message = request.messages[i];
    if (message?.role !== "user") continue;
    const textPart = message.parts.find((part) => part.type === "text");
    if (textPart?.text) return textPart.text as string;
    return "";
  }

  return "";
}

/**
 * Extract conversation history for CQR (conversational query reformulation).
 * Returns all messages EXCEPT the last user message (which is the current query).
 * Only includes user and assistant messages with text content.
 */
function extractConversationHistory(
  request: ChatRequest,
): ConversationMessage[] {
  const messages = request.messages;
  if (messages.length < 2) return [];

  // Find the index of the last user message (current query) to exclude it
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      lastUserIndex = i;
      break;
    }
  }

  // If no prior messages before the last user message, no history to use
  if (lastUserIndex <= 0) return [];

  const history: ConversationMessage[] = [];
  // Extract text content from messages before the current user query
  for (let i = 0; i < lastUserIndex; i += 1) {
    const msg = messages[i];
    if (msg?.role !== "user" && msg?.role !== "assistant") continue;

    const textPart = msg.parts.find((part) => part.type === "text");
    const content = textPart?.text;
    if (!content) continue;

    history.push({
      role: msg.role as "user" | "assistant",
      content: content as string,
    });
  }

  return history;
}

/**
 * Find the last user message in the conversation
 */
function findLastUserMessage(messages: UIMessage[]): UIMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") return messages[i];
  }
  return undefined;
}

/**
 * Resolve model and get capabilities
 */
async function resolveModelForChat(selectedAlias: string) {
  const [aliasRecord] = await db
    .select()
    .from(modelAlias)
    .where(eq(modelAlias.alias, selectedAlias))
    .limit(1);

  if (!aliasRecord) {
    throw new Error(`Model alias '${selectedAlias}' not found`);
  }

  const modelConfig = {
    alias: aliasRecord.alias,
    provider: aliasRecord.provider as ProviderType,
    modelId: aliasRecord.modelId,
  };

  const model = createModel(modelConfig);
  const capabilities = aliasRecord.capabilities as ModelCapabilities | null;

  return { model, capabilities, selectedAlias, provider: aliasRecord.provider };
}

/**
 * Save transcript and metrics after successful completion
 */
type UsageSummary = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

function normalizeUsage(
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  } | null,
): UsageSummary {
  if (!usage) return {};
  const promptTokens =
    typeof usage.inputTokens === "number" ? usage.inputTokens : undefined;
  let completionTokens =
    typeof usage.outputTokens === "number" ? usage.outputTokens : undefined;
  let totalTokens =
    typeof usage.totalTokens === "number" ? usage.totalTokens : undefined;

  if (totalTokens == null && promptTokens != null && completionTokens != null) {
    totalTokens = promptTokens + completionTokens;
  }
  if (completionTokens == null && totalTokens != null && promptTokens != null) {
    const diff = totalTokens - promptTokens;
    completionTokens = diff >= 0 ? diff : undefined;
  }

  return { promptTokens, completionTokens, totalTokens };
}

function calculateCostMicrocents(
  usage: UsageSummary,
  capabilities: ModelCapabilities | null,
): number | undefined {
  const inputRate = capabilities?.costInputPerMillion;
  const outputRate = capabilities?.costOutputPerMillion;
  if (typeof inputRate !== "number" && typeof outputRate !== "number") {
    return undefined;
  }

  const inputTokens = usage.promptTokens ?? 0;
  const outputTokens = usage.completionTokens ?? 0;
  const cost =
    (inputRate ?? 0) * inputTokens + (outputRate ?? 0) * outputTokens;
  if (!Number.isFinite(cost)) return undefined;
  return Math.round(cost);
}

async function saveTranscriptAndMetrics(
  agentData: Agent,
  runId: string,
  request: ChatRequest,
  ragDebugInfo: RAGDebugInfo,
  event: StepResult<ToolSet>,
  startTime: number,
  firstTokenTime?: number,
  modelAlias?: string,
  capabilities?: ModelCapabilities | null,
) {
  const latency = Date.now() - startTime;
  const timeToFirstToken = firstTokenTime
    ? firstTokenTime - startTime
    : undefined;
  const conversationId = request.conversationId || nanoid();
  const usage = normalizeUsage(event.usage ?? null);
  const costMicrocents = calculateCostMicrocents(usage, capabilities ?? null);

  // Save transcript with RAG debug info
  await db.insert(transcript).values({
    id: nanoid(),
    agentId: agentData.id,
    conversationId,
    runId,
    initiatedBy: request.initiatedBy ?? null,
    firebaseUid: request.firebaseUid ?? null,
    request: {
      ...(request as unknown as Record<string, unknown>),
      conversationId,
      ragDebug: ragDebugInfo,
    },
    response: {
      text: event.text,
      finishReason: event.finishReason,
    },
    usage: {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
    },
    latencyMs: latency,
    createdAt: new Date(),
  });

  // Save metrics
  try {
    const metricId = nanoid();
    console.log(
      "[Chat] Saving run metric:",
      `agentId=${agentData.id}`,
      `runId=${runId}`,
      `firebaseUid=${request.firebaseUid ?? "none"}`,
      `initiatedBy=${request.initiatedBy ?? "none"}`,
      `tokens=${usage.totalTokens ?? "n/a"}`,
      `latency=${latency}ms`,
    );
    await db.insert(runMetric).values({
      id: metricId,
      agentId: agentData.id,
      runId,
      conversationId,
      initiatedBy: request.initiatedBy ?? null,
      firebaseUid: request.firebaseUid ?? null,
      modelAlias,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      tokens: usage.totalTokens,
      costMicrocents,
      latencyMs: latency,
      timeToFirstTokenMs: timeToFirstToken,
      createdAt: new Date(),
    });
    console.debug(
      `[Chat] Run metric saved for agent ${agentData.id} (run=${runId}, id=${metricId}, ttft=${timeToFirstToken}ms)`,
    );
  } catch (err) {
    console.warn("[Chat] Failed to insert run metric:", err);
  }
}

/**
 * Save error metric when chat request fails
 */
async function saveErrorMetric(
  agentData: Agent | undefined,
  runId: string,
  startTime: number,
  error: unknown,
  request?: ChatRequest,
  modelAlias?: string,
) {
  const latency = Date.now() - startTime;

  if (!agentData?.id) return;

  try {
    const metricId = nanoid();
    await db.insert(runMetric).values({
      id: metricId,
      agentId: agentData.id,
      runId,
      conversationId: request?.conversationId ?? null,
      initiatedBy: request?.initiatedBy ?? null,
      firebaseUid: request?.firebaseUid ?? null,
      modelAlias,
      latencyMs: latency,
      errorType: error instanceof Error ? error.name : "UnknownError",
      createdAt: new Date(),
    });
    console.debug(
      `[Chat] Error run metric saved for agent ${agentData.id} (run=${runId}, id=${metricId})`,
    );
  } catch (err) {
    console.warn("[Chat] Failed to insert error run metric:", err);
  }
}

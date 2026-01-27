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
  agentModelPolicy,
  modelAlias,
  prompt,
  promptVersion,
  runMetric,
  transcript,
} from "@/db/schema";
import { createModel, type ProviderType } from "@/lib/ai/models";
import { buildSystemPrompt, renderPrompt } from "@/lib/ai/prompt";

// Import refactored modules
import type { ModelCapabilities } from "./helpers";
import { processMessageParts } from "./image-service";
import {
  performRAGRetrieval,
  type RAGConfig,
  type RAGDebugInfo,
} from "./rag-pipeline";

// Re-export functions for backwards compatibility
export { classifyQueryIntent, rewriteQuery } from "./rag-pipeline";

export interface ChatRequest {
  agentSlug: string;
  messages: UIMessage[];
  modelAlias?: string;
  variables?: Record<string, unknown>;
  rag?: {
    enabled?: boolean;
    query?: string;
    topK?: number;
    filters?: Record<string, unknown>;
    rewriteQuery?: boolean;
    rewriteModel?: string;
    rerank?: boolean;
    rerankModel?: string;
  };
  conversationId?: string;
  languageInstruction?: string; // Explicit language instruction for Flutter app
}

/**
 * Handle chat request with RAG
 * Refactored to use extracted helper modules for better maintainability
 */
export async function handleChatRequest(request: ChatRequest, env: Env) {
  const runId = nanoid();
  const startTime = Date.now();

  // Keep in outer scope for error metrics
  let agentData: Agent | undefined;

  try {
    // 1. Resolve agent first (needed for subsequent parallel queries)
    agentData = await resolveAgent(request.agentSlug);

    // 2. Load prompt config and model policy in PARALLEL for speed
    const [{ basePrompt, mergedVariables }, policy] = await Promise.all([
      loadPromptConfig(agentData.id, request.variables),
      loadModelPolicy(agentData.id),
    ]);

    // 3. RAG retrieval (using extracted pipeline)
    const userQuery = extractUserQuery(request);
    const ragConfig: RAGConfig = {
      enabled: agentData.ragEnabled,
      contextualEmbeddingsEnabled:
        agentData.contextualEmbeddingsEnabled ?? false,
      skipIntentClassification: agentData.skipIntentClassification ?? false,
      rewriteQuery: agentData.rewriteQuery,
      rewriteModel: agentData.rewriteModel || undefined,
      intentModel: agentData.intentModel || undefined,
      queryVariationsCount: agentData.queryVariationsCount || 3,
      rerank: agentData.rerank,
      rerankModel: agentData.rerankModel || undefined,
      topK: request.rag?.topK ?? agentData.topK ?? undefined,
      minSimilarity: agentData.minSimilarity ?? undefined,
    };

    const { context: ragContext, debugInfo: ragDebugInfo } =
      await performRAGRetrieval(userQuery, agentData.id, ragConfig);

    // 4. Build final system prompt with RAG context
    let systemPrompt = basePrompt;
    if (ragContext?.chunks && ragContext.chunks.length > 0) {
      systemPrompt = buildSystemPrompt(systemPrompt, ragContext);
    }

    // 4b. Append language instruction if provided (for Flutter app)
    if (request.languageInstruction) {
      systemPrompt = `${systemPrompt}\n\n${request.languageInstruction}`;
    }

    // 5. Resolve model and capabilities
    const { model, capabilities, selectedAlias, provider } =
      await resolveModelForChat(request.modelAlias || policy.modelAlias);

    // 5b. Add chat model info to debug info
    if (ragDebugInfo.models) {
      ragDebugInfo.models.chatModel = selectedAlias;
      ragDebugInfo.models.chatProvider = provider;
    } else {
      ragDebugInfo.models = {
        chatModel: selectedAlias,
        chatProvider: provider,
      };
    }

    // 6. Process messages (handle images based on model capabilities)
    const processedMessages = (await Promise.all(
      request.messages.map(async (msg) => ({
        ...msg,
        parts: await processMessageParts(
          msg.parts,
          capabilities,
          selectedAlias,
          env,
        ),
      })),
    )) as UIMessage[];

    // 7. Convert to model messages
    const modelMessages = await convertToModelMessages(processedMessages);

    // 8. Stream response
    let firstTokenTime: number | undefined;

    const result = streamText({
      model,
      system: systemPrompt,
      messages: modelMessages,
      temperature: policy.temperature || 0.7,
      topP: policy.topP || 1,
      maxOutputTokens: policy.maxTokens || 4096,
      onChunk: (event) => {
        if (!firstTokenTime && event.chunk.type === "text-delta") {
          firstTokenTime = Date.now();
        }
      },
      onFinish: async (event) => {
        await saveTranscriptAndMetrics(
          agentData!,
          runId,
          request,
          ragDebugInfo,
          event,
          startTime,
          firstTokenTime,
        );
      },
    });

    return result;
  } catch (error) {
    await saveErrorMetric(agentData, runId, startTime, error);
    throw error;
  }
}

// ─────────────────────────────────────────────────────
// Helper Functions (extracted from handleChatRequest)
// ─────────────────────────────────────────────────────

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
  if (request.rag?.query) {
    return request.rag.query;
  }

  const lastUserMessage = request.messages[request.messages.length - 1];
  const textPart = lastUserMessage?.parts.find((p) => p.type === "text");
  return (textPart?.text as string) || "";
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
async function saveTranscriptAndMetrics(
  agentData: Agent,
  runId: string,
  request: ChatRequest,
  ragDebugInfo: RAGDebugInfo,
  event: StepResult<ToolSet>,
  startTime: number,
  firstTokenTime?: number,
) {
  const latency = Date.now() - startTime;
  const timeToFirstToken = firstTokenTime
    ? firstTokenTime - startTime
    : undefined;

  // Save transcript with RAG debug info
  await db.insert(transcript).values({
    id: nanoid(),
    agentId: agentData.id,
    conversationId: request.conversationId || nanoid(),
    runId,
    request: {
      ...(request as unknown as Record<string, unknown>),
      ragDebug: ragDebugInfo,
    },
    response: {
      text: event.text,
      finishReason: event.finishReason,
    },
    usage: {
      promptTokens: event.usage.inputTokens,
      completionTokens: event.usage.totalTokens,
      totalTokens: event.usage.totalTokens,
    },
    latencyMs: latency,
    createdAt: new Date(),
  });

  // Save metrics
  try {
    const metricId = nanoid();
    await db.insert(runMetric).values({
      id: metricId,
      agentId: agentData.id,
      runId,
      tokens: event.usage?.totalTokens,
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
) {
  const latency = Date.now() - startTime;

  if (!agentData?.id) return;

  try {
    const metricId = nanoid();
    await db.insert(runMetric).values({
      id: metricId,
      agentId: agentData.id,
      runId,
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

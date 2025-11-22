/**
 * Runtime chat API endpoint
 * Implements the RAG-powered chat flow following AI SDK cookbook pattern
 */

import type { UIMessage } from "ai";
import {
  convertToModelMessages,
  generateObject,
  type LanguageModel,
  streamText,
} from "ai";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import z from "zod";
import { db } from "@/db";
import {
  type Agent,
  agent,
  agentModelPolicy,
  chatImage,
  modelAlias,
  prompt,
  promptVersion,
  runMetric,
  transcript,
} from "@/db/schema";
import {
  findRelevantContent,
  searchDocumentChunksFTS,
} from "@/lib/ai/embedding";
import { createModel, type ProviderType } from "@/lib/ai/models";
import { buildSystemPrompt, renderPrompt } from "@/lib/ai/prompt";
import { reciprocalRankFusion } from "../utils";

export interface ChatRequest {
  agentSlug: string;
  messages: UIMessage[];
  modelAlias?: string;
  variables?: Record<string, unknown>;
  rag?: {
    query?: string;
    topK?: number;
    filters?: Record<string, unknown>;
  };
  requestTags?: string[];
}

export interface ChatOptions {
  env?: {
    OPENAI_API_KEY?: string;
    OPENROUTER_API_KEY?: string;
    CLOUDFLARE_ACCOUNT_ID?: string;
  };
}

interface ImagePart {
  type: "image";
  image: {
    id: string;
    url: string;
    fileName: string;
    mime: string;
    bytes: number;
  };
}

interface MatchMetadata {
  sourceId?: string;
  [key: string]: unknown;
}

/**
 * Query rewriting for improved RAG retrieval
 * Expands user queries into multiple variations to improve search coverage
 * Based on contextual RAG best practices
 */
export async function rewriteQuery(
  model: LanguageModel,
  query: string,
): Promise<{ queries: string[]; keywords: string[] }> {
  const promptText = `Given the following user message, rewrite it into 3-5 distinct queries that could be used to search for relevant information, and provide additional keywords related to the query.

Each query should focus on different aspects or potential interpretations of the original message.
Each keyword should be derived from an interpretation of the provided user message.

User message: ${query}`;

  try {
    const result = await generateObject({
      model,
      prompt: promptText,
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
    });

    console.log(`[Query Rewriting] Original: "${query.substring(0, 50)}..."`);
    console.log(
      `[Query Rewriting] Generated ${result.object.queries.length} query variations`,
    );
    console.log(
      `[Query Rewriting] Extracted ${result.object.keywords.length} keywords`,
    );

    return result.object;
  } catch (error) {
    console.warn("[Query Rewriting] Failed, using original query:", error);
    // Fallback to original query
    return {
      queries: [query],
      keywords: [],
    };
  }
}

/**
 * Handle chat request with RAG
 */
export async function handleChatRequest(request: ChatRequest, env: Env) {
  const runId = nanoid();
  const startTime = Date.now();

  // Keep these in outer scope so we can record error metrics even when an
  // exception happens during agent/model resolution.
  let agentData: Agent | undefined;

  try {
    // 1. Resolve agent
    const [resolvedAgent] = await db
      .select()
      .from(agent)
      .where(eq(agent.slug, request.agentSlug))
      .limit(1);

    if (!resolvedAgent) {
      throw new Error(`Agent '${request.agentSlug}' not found`);
    }

    if (resolvedAgent.status !== "active") {
      throw new Error(`Agent '${request.agentSlug}' is not active`);
    }

    agentData = resolvedAgent;

    // 2. Load active prompt version (label=prod)
    const [systemPromptData] = await db
      .select()
      .from(prompt)
      .where(and(eq(prompt.agentId, agentData.id), eq(prompt.key, "system")))
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

    // 3. Load agent model policy
    const [policy] = await db
      .select()
      .from(agentModelPolicy)
      .where(eq(agentModelPolicy.agentId, agentData.id))
      .orderBy(desc(agentModelPolicy.effectiveFrom))
      .limit(1);

    if (!policy) {
      throw new Error("No model policy found");
    }

    // 4. Render prompt with variables
    const mergedVariables = {
      ...activePromptVersion.variables,
      ...request.variables,
    };
    const basePrompt = renderPrompt(
      activePromptVersion.content,
      mergedVariables,
    );

    // 5. RAG retrieval with hybrid search (vector + FTS)
    let ragContext;

    const ragEnabled = Boolean(
      request.rag ||
        (Array.isArray(policy.enabledTools) &&
          policy.enabledTools.includes("retrieval")),
    );

    console.log(
      "[Chat] RAG config - request.rag:",
      request.rag,
      "policy.enabledTools:",
      policy.enabledTools,
      "ragEnabled:",
      ragEnabled,
    );

    if (ragEnabled) {
      // Extract query from request or use last user message
      const lastUserMessage = request.messages[request.messages.length - 1];
      const userQuery =
        request.rag?.query ||
        (lastUserMessage?.parts.find((p) => p.type === "text")
          ?.text as string) ||
        "";

      if (userQuery && userQuery.trim().length > 0) {
        console.log(
          `[Chat] Performing hybrid RAG search for: "${userQuery.substring(
            0,
            100,
          )}..."`,
        );

        // Step 1: Rewrite query into multiple variations
        const { queries, keywords } = await rewriteQuery(
          createModel({
            alias: "@cf/meta/llama-3.1-8b-instruct-fast",
            provider: "workers-ai",
            modelId: "@cf/meta/llama-3.1-8b-instruct-fast",
          }),
          userQuery,
        );

        console.log(
          `[Chat] Query rewritten into ${queries.length} variations with ${keywords.length} keywords`,
        );

        // Step 2: Perform vector search for all query variations
        const vectorSearchPromises = queries.map((q) =>
          findRelevantContent(q, agentData!.id, {
            topK: 5,
            minSimilarity: 0.3,
          }),
        );

        // Step 3: Perform FTS search for keywords
        const ftsResults = await searchDocumentChunksFTS(
          keywords,
          agentData!.id,
          {
            limit: 5,
          },
        );

        const [vectorResults] = await Promise.all([
          Promise.all(vectorSearchPromises),
        ]);

        console.log(
          `[Chat] Vector search: ${vectorResults.reduce(
            (sum, r) => sum + r.matches.length,
            0,
          )} results`,
        );
        console.log(`[Chat] FTS search: ${ftsResults.length} results`);

        if (keywords.length > 0 && ftsResults.length === 0) {
          console.warn(
            "[Chat] FTS search returned no results despite having keywords. FTS index may need rebuilding.",
          );
        }

        // Step 4: Apply reciprocal rank fusion to merge vector and FTS results

        // Convert FTS results to match format
        const ftsMatches = ftsResults.map((r, idx) => ({
          id: r.id,
          content: r.text,
          score: -r.rank, // FTS rank is negative, convert to positive score
          metadata: {},
        }));

        // Merge all result sets
        const allResultSets = [
          ...vectorResults.map((r) => r.matches),
          ftsMatches,
        ];

        const fusedResults = reciprocalRankFusion(allResultSets, 60);
        const topMatches = fusedResults.slice(0, request.rag?.topK || 6);

        if (topMatches.length > 0) {
          console.log(
            `[Chat] Hybrid search retrieved ${topMatches.length} chunks after RRF fusion`,
          );
          console.log(
            `[Chat] Score range: ${topMatches[0].score.toFixed(
              3,
            )} to ${topMatches[topMatches.length - 1].score.toFixed(3)}`,
          );

          ragContext = {
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
        } else {
          console.log(`[Chat] Hybrid search found no relevant chunks`);
        }
      }
    }

    // 6. Build final system prompt with RAG context
    let systemPrompt = basePrompt;

    if (ragContext?.chunks && ragContext.chunks.length > 0) {
      systemPrompt = buildSystemPrompt(systemPrompt, ragContext);
    }

    // 7. Create model instance
    // Resolve model alias into provider/modelId/gatewayRoute from the model_alias table
    const selectedAlias = request.modelAlias || policy.modelAlias;
    let modelConfig;
    if (selectedAlias) {
      const [aliasRecord] = await db
        .select()
        .from(modelAlias)
        .where(eq(modelAlias.alias, selectedAlias))
        .limit(1);

      if (!aliasRecord) {
        throw new Error(`Model alias '${selectedAlias}' not found`);
      }

      modelConfig = {
        alias: aliasRecord.alias,
        provider: aliasRecord.provider as ProviderType,
        modelId: aliasRecord.modelId,
      };
    } else {
      // Fallback - use policy.modelAlias if present
      modelConfig = {
        alias: policy.modelAlias,
        provider: "openai" as const,
        modelId: "gpt-5-mini",
      };
    }

    const model = createModel(modelConfig);

    // 8. Preprocess messages for model compatibility
    // Always include image data - let the model handle unsupported formats
    const processedMessages = await Promise.all(
      request.messages.map(async (msg) => ({
        ...msg,
        parts: await Promise.all(
          msg.parts.map(async (part) => {
            // Type guard to check if this is an image part
            if ("type" in part && (part as { type: string }).type === "image") {
              const imagePart = part as unknown as ImagePart;
              const imageData = imagePart.image;

              // Fetch image metadata from database
              const [imageRecord] = await db
                .select()
                .from(chatImage)
                .where(eq(chatImage.id, imageData.id))
                .limit(1);

              if (!imageRecord || !imageRecord.r2Key) {
                throw new Error(`Image not found: ${imageData.id}`);
              }

              // Fetch image from R2
              const r2Object = await env.R2.get(imageRecord.r2Key);

              if (!r2Object) {
                throw new Error(`Image not found in R2: ${imageRecord.r2Key}`);
              }

              // Convert to base64
              const arrayBuffer = await r2Object.arrayBuffer();
              const base64 = Buffer.from(arrayBuffer).toString("base64");

              return {
                type: "file" as const,
                mediaType: imageData.mime,
                url: `data:${imageData.mime};base64,${base64}`,
              };
            }
            return part;
          }),
        ),
      })),
    );

    // 9. Convert to model messages
    const modelMessages = convertToModelMessages(processedMessages);

    // 10. Stream response
    const result = streamText({
      model,
      system: systemPrompt,
      messages: modelMessages,
      temperature: policy.temperature || 0.7,
      topP: policy.topP || 1,
      onFinish: async (event) => {
        const latency = Date.now() - startTime;

        // Save transcript
        await db.insert(transcript).values({
          id: nanoid(),
          agentId: agentData!.id,
          conversationId: request.requestTags?.[0] || nanoid(),
          runId,
          request: request as unknown as Record<string, unknown>,
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

        // Save metrics (tokens, latency and optional cost estimate)
        try {
          const metricId = nanoid();
          await db.insert(runMetric).values({
            id: metricId,
            agentId: agentData!.id,
            runId,
            tokens: event.usage?.totalTokens,
            latencyMs: latency,
            createdAt: new Date(),
          });
          console.debug(
            `[Chat] Run metric saved for agent ${agentData!.id} (run=${runId}, id=${metricId})`,
          );
        } catch (err) {
          console.warn("[Chat] Failed to insert run metric:", err);
        }
      },
    });

    return result;
  } catch (error) {
    const latency = Date.now() - startTime;

    // Log error metric if we have an agent id
    try {
      if (agentData?.id) {
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
      }
    } catch (err) {
      console.warn("[Chat] Failed to insert error run metric:", err);
    }

    throw error;
  }
}

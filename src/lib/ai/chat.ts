/**
 * Runtime chat API endpoint
 * Implements the RAG-powered chat flow following AI SDK cookbook pattern
 */

import { db } from "@/db";
import {
  agent,
  agentIndexPin,
  agentModelPolicy,
  prompt,
  promptVersion,
  transcript,
} from "@/db/schema";
import { findRelevantContent } from "@/lib/ai/embedding";
import { createModel } from "@/lib/ai/models";
import { buildSystemPrompt, renderPrompt } from "@/lib/ai/prompt";
import type { UIMessage } from "ai";
import { convertToModelMessages, stepCountIs, streamText, tool } from "ai";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import z from "zod";

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

/**
 * Handle chat request with RAG
 */
export async function handleChatRequest(
  request: ChatRequest,
  options?: ChatOptions
) {
  const runId = nanoid();
  const startTime = Date.now();

  try {
    // 1. Resolve agent
    const [agentData] = await db
      .select()
      .from(agent)
      .where(eq(agent.slug, request.agentSlug))
      .limit(1);

    if (!agentData) {
      throw new Error(`Agent '${request.agentSlug}' not found`);
    }

    if (agentData.status !== "active") {
      throw new Error(`Agent '${request.agentSlug}' is not active`);
    }

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
          eq(promptVersion.label, "prod")
        )
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
      mergedVariables
    );

    // 5. RAG retrieval - proactive context loading
    let ragContext;
    const ragEnabled = Boolean(
      request.rag || 
      (Array.isArray(policy.enabledTools) && policy.enabledTools.includes("retrieval"))
    );
    
    console.log(
      "[Chat] RAG config - request.rag:",
      request.rag,
      "policy.enabledTools:",
      policy.enabledTools,
      "ragEnabled:",
      ragEnabled
    );
    
    // Always attempt retrieval if policy enables it OR if explicitly requested
    if (ragEnabled) {
      const [indexPin] = await db
        .select()
        .from(agentIndexPin)
        .where(eq(agentIndexPin.agentId, agentData.id))
        .limit(1);

      if (indexPin) {
        // Extract query from request or use last user message
        const lastUserMessage = request.messages[request.messages.length - 1];
        const query =
          request.rag?.query ||
          (lastUserMessage?.parts.find((p) => p.type === "text")?.text as string) ||
          "";
          
        if (query && query.trim().length > 0) {
          console.log(`[Chat] Performing initial RAG retrieval for: "${query.substring(0, 100)}..."`);
          
          const results = await findRelevantContent(query, agentData.id, {
            topK: request.rag?.topK || 6,
            indexVersion: indexPin.indexVersion,
            minSimilarity: 0.3, // Lower threshold for initial context
          });

          if (results.matches.length > 0) {
            console.log(`[Chat] Initial RAG retrieved ${results.matches.length} chunks (avg score: ${(results.matches.reduce((sum, m) => sum + m.score, 0) / results.matches.length).toFixed(3)})`);
            
            ragContext = {
              chunks: results.matches.map((match) => ({
                content: String(match.content), // Ensure content is string
                sourceId: (match.metadata?.sourceId as string) || match.id,
                score: match.score,
                metadata: match.metadata,
              })),
            };
          } else {
            console.log(`[Chat] Initial RAG found no relevant chunks for query: "${query.substring(0, 50)}..."`);
          }
        } else {
          console.log("[Chat] No valid query for initial RAG retrieval");
        }
      } else {
        console.log("[Chat] No index pin found for agent - RAG disabled");
      }
    } else {
      console.log("[Chat] RAG not enabled for this request");
    }

    // 6. Build final system prompt with RAG context and tool instructions
    let systemPrompt = basePrompt;
    
    // Add tool usage instruction FIRST before any context
    systemPrompt += `

## Available Tools
You have access to a "getInformation" tool that searches your knowledge base. 

**CRITICAL INSTRUCTION**: For ANY question about:
- Implementation plans, timelines, or project details
- Technical specifications or architecture
- Factual information about the project
- Code examples or documentation

You MUST use the "getInformation" tool FIRST before responding. Do not rely solely on the context provided below or your training data. Always verify with the knowledge base.

## How to Use the Tool
1. Extract the user's main question or query
2. Call getInformation with that question
3. Use the retrieved context to formulate your answer
4. Cite sources when relevant`;

    // Add initial RAG context if available (this is from initial retrieval)
    if (ragContext?.chunks && ragContext.chunks.length > 0) {
      systemPrompt = buildSystemPrompt(systemPrompt, ragContext);
    }

    // 7. Create model instance
    const modelConfig = {
      alias: request.modelAlias || policy.modelAlias,
      provider: "openai" as const, // Would be loaded from modelAlias table
      modelId: "gpt-4o-mini", // Would be loaded from modelAlias table
    };

    const model = createModel(modelConfig, options?.env);

    // 8. Stream response
    const result = streamText({
      model,
      system: systemPrompt,
      messages: convertToModelMessages(request.messages),
      stopWhen: stepCountIs(5),
      temperature: policy.temperature || 0.7,
      topP: policy.topP || 1,
      tools: {
        getInformation: tool({
          description: `Search your knowledge base for relevant information. This tool retrieves the most relevant content from your indexed documents based on semantic similarity. Use this EVERY TIME before answering questions about project-specific information, implementation details, or documentation.`,
          inputSchema: z.object({
            question: z.string().describe("The user's question or the specific information you need to retrieve from the knowledge base"),
          }),
          execute: async ({ question }) => {
            console.log(`[RAG Tool] Searching knowledge base for: "${question}"`);
            
            const results = await findRelevantContent(question, agentData.id, {
              topK: 6,
            });
            
            console.log(`[RAG Tool] Found ${results.matches.length} results`);
            
            if (results.matches.length === 0) {
              return {
                status: "no_results",
                message: "No relevant information found in the knowledge base for this query. The knowledge base may need to be updated with relevant content.",
                query: question,
              };
            }
            
            // Format with clear structure for LLM consumption
            const formattedResults = results.matches.map((match, idx) => ({
              rank: idx + 1,
              relevanceScore: match.score.toFixed(3),
              content: match.content,
              source: match.metadata?.fileName || "Unknown",
              sourceId: match.metadata?.sourceId,
            }));
            
            // Create a well-structured text response
            const contextText = formattedResults
              .map(r => 
                `[Result ${r.rank} - Relevance: ${r.relevanceScore} - Source: ${r.source}]\n${r.content}`
              )
              .join("\n\n" + "─".repeat(80) + "\n\n");

            return {
              status: "success",
              query: question,
              resultsFound: results.matches.length,
              context: contextText,
              sources: formattedResults.map(r => ({
                source: r.source,
                relevance: r.relevanceScore,
              })),
              matches: formattedResults.map(r => ({
                content: r.content,
                score: Number(r.relevanceScore),
                source: r.source,
                sourceId: r.sourceId,
              })),
            };
          },
        }),
      },
      onFinish: async (event) => {
        const latency = Date.now() - startTime;

        // Save transcript
        await db.insert(transcript).values({
          id: nanoid(),
          agentId: agentData.id,
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

        // // Save metrics
        // await db.insert(runMetric).values({
        // 	id: nanoid(),
        // 	agentId: agentData.id,
        // 	runId,
        // 	tokens: event.usage.totalTokens,
        // 	latencyMs: latency,
        // 	createdAt: new Date(),
        // });
      },
    });

    return result;
  } catch (error) {
    const latency = Date.now() - startTime;

    // Log error metric
    // await db.insert(runMetric).values({
    // 	id: nanoid(),
    // 	agentId: request.agentSlug,
    // 	runId,
    // 	latencyMs: latency,
    // 	errorType: error instanceof Error ? error.name : "UnknownError",
    // 	createdAt: new Date(),
    // });

    throw error;
  }
}

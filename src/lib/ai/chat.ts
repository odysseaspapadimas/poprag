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
import { convertToModelMessages, generateObject, stepCountIs, streamText, tool, type LanguageModel } from "ai";
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
 * Query rewriting for improved RAG retrieval
 * Expands user queries into multiple variations to improve search coverage
 * Based on contextual RAG best practices
 */
export async function rewriteQuery(
  model: LanguageModel,
  query: string
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
        queries: z.array(z.string()).describe(
          "Similar queries to the user's query. Be concise but comprehensive."
        ),
        keywords: z.array(z.string()).describe(
          "Keywords from the query to use for full-text search"
        ),
      }),
    });

    console.log(`[Query Rewriting] Original: "${query.substring(0, 50)}..."`);
    console.log(`[Query Rewriting] Generated ${result.object.queries.length} query variations`);
    console.log(`[Query Rewriting] Extracted ${result.object.keywords.length} keywords`);

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

    // 5. RAG retrieval - proactive context loading with query rewriting
    let ragContext;
    let rewrittenQueries: string[] = [];
    let extractedKeywords: string[] = [];
    
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
          
          // Optional: Use query rewriting for improved retrieval
          // Create a temporary model for query rewriting (lightweight model)
          const tempModelConfig = {
            alias: "gpt-4o-mini",
            provider: "openai" as const,
            modelId: "gpt-4o-mini",
          };
          const tempModel = createModel(tempModelConfig, options?.env);
          
          // Rewrite query into multiple variations
          const { queries, keywords } = await rewriteQuery(tempModel, query);
          rewrittenQueries = queries;
          extractedKeywords = keywords;
          
          // Perform retrieval for ALL query variations and merge results
          const retrievalPromises = queries.map(q => 
            findRelevantContent(q, agentData.id, {
              topK: Math.ceil((request.rag?.topK || 6) / queries.length), // Distribute topK across queries
              indexVersion: indexPin.indexVersion,
              minSimilarity: 0.3, // Lower threshold for initial context
              keywords: extractedKeywords,
              useHybridSearch: true,
            })
          );
          
          const retrievalResults = await Promise.all(retrievalPromises);
          
          // Merge and deduplicate results from all queries
          const allMatches = retrievalResults.flatMap(r => r.matches);
          
          // Use reciprocal rank fusion to merge results
          const { reciprocalRankFusion } = await import("@/lib/utils");
          const fusedResults = reciprocalRankFusion(
            retrievalResults.map(r => r.matches),
            60 // k constant
          );
          
          // Take top K after fusion
          const topMatches = fusedResults.slice(0, request.rag?.topK || 6);

          if (topMatches.length > 0) {
            console.log(`[Chat] Initial RAG retrieved ${topMatches.length} chunks after query rewriting and fusion`);
            console.log(`[Chat] Query variations used: ${rewrittenQueries.length}, Keywords: ${extractedKeywords.join(", ")}`);
            console.log(`[Chat] Score range: ${topMatches[0].score.toFixed(3)} to ${topMatches[topMatches.length - 1].score.toFixed(3)}`);
            
            ragContext = {
              chunks: topMatches.map((match) => ({
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
You have access to a "getInformation" tool that searches your knowledge base using advanced semantic search.

**CRITICAL INSTRUCTION**: For ANY question about:
- Implementation plans, timelines, or project details
- Technical specifications or architecture
- Factual information about the project
- Code examples or documentation

You MUST use the "getInformation" tool FIRST before responding. Do not rely solely on the context provided below or your training data. Always verify with the knowledge base.

## How to Use the Tool
1. Extract the user's main question or query (be specific)
2. Call getInformation with that question
3. The tool will automatically:
   - Rewrite your query into multiple variations
   - Search using both semantic similarity and keyword matching
   - Rank and merge results from different search methods
4. Use the retrieved context to formulate your answer
5. Cite sources when relevant

## Initial Context
The following context was retrieved based on the user's query${rewrittenQueries.length > 1 ? ` (using ${rewrittenQueries.length} query variations)` : ''}:`;

    // Add initial RAG context if available (this is from initial retrieval with query rewriting)
    if (ragContext?.chunks && ragContext.chunks.length > 0) {
      systemPrompt = buildSystemPrompt(systemPrompt, ragContext);
      systemPrompt += `

**Note**: This initial context is based on query expansion and hybrid search. If you need more specific information, use the getInformation tool with a focused query.`;
    } else {
      systemPrompt += `

No initial context was found. Use the getInformation tool to search the knowledge base.`;
    }

    // 7. Create model instance
    const modelConfig = {
      alias: request.modelAlias || policy.modelAlias,
      provider: "openai" as const, // Would be loaded from modelAlias table
      modelId: "gpt-5-mini", // Would be loaded from modelAlias table
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
          description: `Search your knowledge base using advanced contextual RAG. This tool:
1. Rewrites your query into multiple variations for better coverage
2. Performs hybrid search (semantic + keyword matching)
3. Merges and ranks results using reciprocal rank fusion
Use this EVERY TIME before answering questions about project-specific information.`,
          inputSchema: z.object({
            question: z.string().describe("The user's question or the specific information you need to retrieve from the knowledge base"),
          }),
          execute: async ({ question }) => {
            console.log(`[RAG Tool] Searching knowledge base for: "${question}"`);
            
            // Rewrite query for better retrieval
            const { queries, keywords } = await rewriteQuery(model, question);
            console.log(`[RAG Tool] Query rewritten into ${queries.length} variations with ${keywords.length} keywords`);
            
            // Perform retrieval for all query variations
            const retrievalPromises = queries.map(q => 
              findRelevantContent(q, agentData.id, {
                topK: Math.ceil(6 / queries.length), // Distribute topK
                keywords: keywords,
                useHybridSearch: true,
              })
            );
            
            const retrievalResults = await Promise.all(retrievalPromises);
            
            // Merge results using reciprocal rank fusion
            const { reciprocalRankFusion } = await import("@/lib/utils");
            const fusedResults = reciprocalRankFusion(
              retrievalResults.map(r => r.matches),
              60
            );
            
            const topMatches = fusedResults.slice(0, 6);
            
            console.log(`[RAG Tool] Found ${topMatches.length} results after fusion`);
            
            if (topMatches.length === 0) {
              return {
                status: "no_results",
                message: "No relevant information found in the knowledge base for this query. The knowledge base may need to be updated with relevant content.",
                query: question,
                queryVariations: queries,
                keywords: keywords,
              };
            }
            
            // Format with clear structure for LLM consumption
            const formattedResults = topMatches.map((match, idx) => ({
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
              queryVariations: queries,
              keywords: keywords,
              resultsFound: topMatches.length,
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

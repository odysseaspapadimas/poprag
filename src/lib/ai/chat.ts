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
    runMetric,
    transcript,
} from "@/db/schema";
import { findRelevantContent } from "@/lib/ai/embedding";
import { createModel } from "@/lib/ai/models";
import { buildSystemPrompt, renderPrompt } from "@/lib/ai/prompt";
import { streamText, type CoreMessage } from "ai";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";

export interface ChatRequest {
	agentSlug: string;
	messages: CoreMessage[];
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
	options?: ChatOptions,
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
			.where(
				and(eq(prompt.agentId, agentData.id), eq(prompt.key, "system")),
			)
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

		// 5. RAG retrieval if needed
		let ragContext;
		if (request.rag || policy.enabledTools?.includes("retrieval")) {
			const [indexPin] = await db
				.select()
				.from(agentIndexPin)
				.where(eq(agentIndexPin.agentId, agentData.id))
				.limit(1);

			if (indexPin) {
				const query =
					request.rag?.query ||
					(request.messages[request.messages.length - 1]?.content as string);

				const results = await findRelevantContent(query, agentData.id, {
					topK: request.rag?.topK || 6,
					indexVersion: indexPin.indexVersion,
				});

				ragContext = {
					chunks: results.matches.map((match) => ({
						content: match.content, // Full text from Vectorize metadata
						sourceId: match.metadata?.sourceId as string,
						score: match.score,
						metadata: match.metadata,
					})),
				};
			}
		}

		// 6. Build final system prompt
		const systemPrompt = buildSystemPrompt(basePrompt, ragContext);

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
			messages: request.messages,
			temperature: policy.temperature || 0.7,
			topP: policy.topP || 1,
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

				// Save metrics
				await db.insert(runMetric).values({
					id: nanoid(),
					agentId: agentData.id,
					runId,
					tokens: event.usage.totalTokens,
					latencyMs: latency,
					createdAt: new Date(),
				});
			},
		});

		return result;
	} catch (error) {
		const latency = Date.now() - startTime;

		// Log error metric
		await db.insert(runMetric).values({
			id: nanoid(),
			agentId: request.agentSlug,
			runId,
			latencyMs: latency,
			errorType: error instanceof Error ? error.name : "UnknownError",
			createdAt: new Date(),
		});

		throw error;
	}
}

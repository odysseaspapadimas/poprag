import { createOpenAI, openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

export type ProviderType = "openai" | "openrouter" | "huggingface" | "workers-ai";

export interface ModelConfig {
	alias: string;
	provider: ProviderType;
	modelId: string;
	gatewayRoute?: string;
	baseURL?: string;
}

/**
 * Create a language model instance from configuration
 * Supports AI Gateway routing and multiple providers
 */
export function createModel(
	config: ModelConfig,
	env?: {
		OPENAI_API_KEY?: string;
		OPENROUTER_API_KEY?: string;
		CLOUDFLARE_ACCOUNT_ID?: string;
		CLOUDFLARE_GATEWAY_ID?: string;
	},
): LanguageModel {
	switch (config.provider) {
		case "openai": {
			// If gateway route specified, use Cloudflare AI Gateway
			if (config.gatewayRoute && env?.CLOUDFLARE_ACCOUNT_ID) {
				const baseURL = `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${config.gatewayRoute}/openai`;
				const customOpenAI = createOpenAI({ baseURL });
				return customOpenAI(config.modelId);
			}

			// Direct OpenAI connection
			return openai(config.modelId);
		}

		case "openrouter": {
			// OpenRouter via OpenAI-compatible endpoint
			const baseURL = config.gatewayRoute
				? `https://gateway.ai.cloudflare.com/v1/${env?.CLOUDFLARE_ACCOUNT_ID}/${config.gatewayRoute}/openrouter`
				: "https://openrouter.ai/api/v1";

			const customOpenAI = createOpenAI({
				baseURL,
				apiKey: env?.OPENROUTER_API_KEY,
			});
			return customOpenAI(config.modelId);
		}

		case "workers-ai": {
			// Workers AI would use Cloudflare's AI binding
			// This is a placeholder - actual implementation needs env.AI binding
			throw new Error(
				"Workers AI provider requires Cloudflare AI binding - implement in runtime",
			);
		}

		case "huggingface": {
			// Hugging Face via OpenAI-compatible endpoint
			const baseURL = config.baseURL || "https://api-inference.huggingface.co/v1";
			const customOpenAI = createOpenAI({ baseURL });
			return customOpenAI(config.modelId);
		}

		default:
			throw new Error(`Unknown provider: ${config.provider}`);
	}
}

/**
 * Create embedding model instance
 */
export function createEmbeddingModel(
	config: {
		provider: ProviderType;
		modelId: string;
		dimensions?: number;
	},
	env?: {
		OPENAI_API_KEY?: string;
	},
) {
	switch (config.provider) {
		case "openai":
			return openai.embedding(config.modelId);

		case "workers-ai":
			// Workers AI embedding would use binding
			throw new Error(
				"Workers AI embeddings require Cloudflare AI binding - implement in runtime",
			);

		default:
			throw new Error(
				`Embedding not supported for provider: ${config.provider}`,
			);
	}
}

/**
 * Get default model configurations
 */
export const DEFAULT_MODELS: Record<string, ModelConfig> = {
	"gpt-4o": {
		alias: "gpt-4o",
		provider: "openai",
		modelId: "gpt-4o",
	},
	"gpt-4o-mini": {
		alias: "gpt-4o-mini",
		provider: "openai",
		modelId: "gpt-4o-mini",
	},
	"gpt-3.5-turbo": {
		alias: "gpt-3.5-turbo",
		provider: "openai",
		modelId: "gpt-3.5-turbo",
	},
};

/**
 * Get default embedding model
 */
export const DEFAULT_EMBEDDING_MODEL = {
	provider: "openai" as const,
	modelId: "text-embedding-3-small",
	dimensions: 1536,
};

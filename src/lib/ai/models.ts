import { createOpenAI, openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { createAiGateway } from "ai-gateway-provider";
import { env } from "cloudflare:workers";
import { createWorkersAI } from "workers-ai-provider";

export type ProviderType =
  | "openai"
  | "openrouter"
  | "huggingface"
  | "cloudflare-workers-ai";

export interface ModelConfig {
  alias: string;
  provider: ProviderType;
  modelId: string;
  baseURL?: string;
}

/**
 * Create a language model instance from configuration
 * All AI calls now go through AI SDK with AI Gateway integration
 */
export function createModel(config: ModelConfig): LanguageModel {
  // Create AI Gateway instance if configured - applies to all providers
  const aigateway =
    env.AI_GATEWAY_ID && env.AI
      ? createAiGateway({
          binding: env.AI.gateway(env.AI_GATEWAY_ID),
        })
      : null;

  switch (config.provider) {
    case "openai": {
      const openaiProvider = createOpenAI({
        apiKey: env.OPENAI_API_KEY,
      });

      const model = openaiProvider(config.modelId);

      // Route through AI Gateway if configured
      return aigateway ? aigateway([model]) : model;
    }

    // case "openrouter": {
    //   const openrouterProvider = createOpenAI({
    //     baseURL: "https://openrouter.ai/api/v1",
    //     apiKey: env.OPENROUTER_API_KEY,
    //   });

    //   const model = openrouterProvider(config.modelId);

    //   // Route through AI Gateway if configured
    //   return aigateway ? aigateway([model]) : model;
    // }

    case "cloudflare-workers-ai": {
      // Workers AI through AI SDK provider
      if (!env.AI) {
        throw new Error("Workers AI requires AI binding");
      }

      const workersAIProvider = createWorkersAI({
        binding: env.AI,
      });

      // Workers AI - provider accepts model IDs directly
      // Model IDs like "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
      // Type assertion needed as provider has strict typing for text generation models
      const model = workersAIProvider(config.modelId as any);

      // Workers AI runs locally on Cloudflare - don't route through AI Gateway
      // as it would try to route to external "workersai.chat" provider which doesn't exist
      return model;
    }

    case "huggingface": {
      // Hugging Face via OpenAI-compatible endpoint
      const huggingfaceProvider = createOpenAI({
        baseURL: config.baseURL || "https://api-inference.huggingface.co/v1",
      });

      const model = huggingfaceProvider(config.modelId);

      // Route through AI Gateway if configured
      return aigateway ? aigateway([model]) : model;
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
  env: {
    OPENAI_API_KEY?: string;
  },
) {
  switch (config.provider) {
    case "openai":
      return openai.embedding(config.modelId);

    case "cloudflare-workers-ai":
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

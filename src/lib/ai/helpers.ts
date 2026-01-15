/**
 * Shared helpers for AI operations
 * Reduces duplication across chat, embedding, and other AI-related code
 */

import type { LanguageModel } from "ai";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { modelAlias } from "@/db/schema";
import {
  DEFAULT_MODELS,
  DEFAULT_PROVIDER,
  type ProviderType,
} from "./constants";
import { createModel, type ModelConfig } from "./models";

/**
 * Resolve a model alias from the database and create a LanguageModel instance
 * Handles fallback to Workers AI if alias not found in database
 *
 * @param alias - The model alias to resolve (e.g., "gpt-4o" or "@cf/meta/llama-3.3-70b-instruct-fp8-fast")
 * @returns A configured LanguageModel instance
 */
export async function resolveAndCreateModel(
  alias: string,
): Promise<LanguageModel> {
  // Look up the model alias from DB to get the correct provider
  const [aliasRecord] = await db
    .select()
    .from(modelAlias)
    .where(eq(modelAlias.alias, alias))
    .limit(1);

  // If model alias not found, try to use it directly as a Workers AI model
  const config: ModelConfig = {
    alias,
    provider: (aliasRecord?.provider as ProviderType) || DEFAULT_PROVIDER,
    modelId: aliasRecord?.modelId || alias,
  };

  return createModel(config);
}

/**
 * Resolve model configuration without creating the model
 * Useful when you need the config for logging or other purposes
 *
 * @param alias - The model alias to resolve
 * @returns Model configuration object
 */
export async function resolveModelConfig(alias: string): Promise<ModelConfig> {
  const [aliasRecord] = await db
    .select()
    .from(modelAlias)
    .where(eq(modelAlias.alias, alias))
    .limit(1);

  return {
    alias,
    provider: (aliasRecord?.provider as ProviderType) || DEFAULT_PROVIDER,
    modelId: aliasRecord?.modelId || alias,
  };
}

/**
 * Get the default model for a specific purpose
 *
 * @param purpose - The purpose: "intent", "rewrite", "embedding", or "rerank"
 * @returns The default model ID for that purpose
 */
export function getDefaultModel(
  purpose: "intent" | "rewrite" | "embedding" | "rerank",
): string {
  switch (purpose) {
    case "intent":
      return DEFAULT_MODELS.INTENT_CLASSIFICATION;
    case "rewrite":
      return DEFAULT_MODELS.QUERY_REWRITE;
    case "embedding":
      return DEFAULT_MODELS.EMBEDDING;
    case "rerank":
      return DEFAULT_MODELS.RERANKER;
    default:
      return DEFAULT_MODELS.INTENT_CLASSIFICATION;
  }
}

/**
 * Model capabilities stored in DB
 */
export interface ModelCapabilities {
  inputModalities?: ("text" | "image" | "audio" | "video" | "pdf")[];
  outputModalities?: ("text" | "image" | "audio")[];
  toolCall?: boolean;
  reasoning?: boolean;
  structuredOutput?: boolean;
  attachment?: boolean;
  contextLength?: number;
  maxOutputTokens?: number;
  costInputPerMillion?: number;
  costOutputPerMillion?: number;
}

/**
 * Check if a model supports a specific input modality
 *
 * @param capabilities - Model capabilities from database
 * @param modality - The modality to check for
 * @returns true if the model supports the modality
 */
export function supportsModality(
  capabilities: ModelCapabilities | null | undefined,
  modality: "text" | "image" | "audio" | "video" | "pdf",
): boolean {
  if (!capabilities?.inputModalities) {
    // If no capabilities are stored, default to text only for safety
    return modality === "text";
  }
  return capabilities.inputModalities.includes(modality);
}

/**
 * Get model capabilities from alias
 *
 * @param alias - The model alias to look up
 * @returns Model capabilities or null if not found
 */
export async function getModelCapabilities(
  alias: string,
): Promise<ModelCapabilities | null> {
  const [aliasRecord] = await db
    .select()
    .from(modelAlias)
    .where(eq(modelAlias.alias, alias))
    .limit(1);

  return (aliasRecord?.capabilities as ModelCapabilities) || null;
}

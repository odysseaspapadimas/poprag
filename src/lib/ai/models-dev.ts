/**
 * Models.dev API integration
 * Comprehensive open-source database of AI model specifications, pricing, and capabilities
 * @see https://models.dev
 */

// ─────────────────────────────────────────────────────
// Types for models.dev API
// ─────────────────────────────────────────────────────

export type InputModality = "text" | "image" | "audio" | "video" | "pdf";
export type OutputModality = "text" | "image" | "audio";

export interface ModelsDevCost {
  input: number; // Cost per million input tokens (USD)
  output: number; // Cost per million output tokens (USD)
  reasoning?: number; // Cost per million reasoning tokens (USD)
  cache_read?: number; // Cost per million cached read tokens (USD)
  cache_write?: number; // Cost per million cached write tokens (USD)
  input_audio?: number; // Cost per million audio input tokens (USD)
  output_audio?: number; // Cost per million audio output tokens (USD)
}

export interface ModelsDevLimit {
  context: number; // Maximum context window (tokens)
  input?: number; // Maximum input tokens
  output: number; // Maximum output tokens
}

export interface ModelsDevModalities {
  input: InputModality[];
  output: OutputModality[];
}

export interface ModelsDevInterleaved {
  field?: "reasoning_content" | "reasoning_details";
}

// Model as stored in API (without full ID)
export interface ModelsDevModelData {
  name: string; // Display name
  family?: string; // Model family (e.g., "gpt-4", "text-embedding", "claude")
  attachment: boolean; // Supports file attachments
  reasoning: boolean; // Supports reasoning / chain-of-thought
  tool_call: boolean; // Supports tool calling
  structured_output?: boolean; // Supports structured output
  temperature?: boolean; // Supports temperature control
  knowledge?: string; // Knowledge-cutoff date (YYYY-MM or YYYY-MM-DD)
  release_date?: string; // First public release date
  last_updated?: string; // Most recent update date
  open_weights?: boolean; // Model weights are publicly available
  cost: ModelsDevCost;
  limit: ModelsDevLimit;
  modalities: ModelsDevModalities;
  interleaved?: boolean | ModelsDevInterleaved;
  status?: "alpha" | "beta" | "deprecated";
}

// Model with full ID and provider (normalized for our use)
export interface ModelsDevModel extends ModelsDevModelData {
  id: string; // Full model ID (provider/model or just model-name)
  provider: string; // Provider ID
}

// Provider with nested models
export interface ModelsDevProvider {
  id: string;
  name: string;
  npm: string;
  env: string[];
  doc: string;
  api?: string; // OpenAI-compatible API endpoint
  models: Record<string, ModelsDevModelData>;
}

// API response is a Record of providers
export type ModelsDevAPIResponse = Record<
  string,
  Omit<ModelsDevProvider, "id">
>;

// ─────────────────────────────────────────────────────
// API Client
// ─────────────────────────────────────────────────────

const MODELS_DEV_API_URL = "https://models.dev/api.json";

let cachedData: ModelsDevAPIResponse | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 1000 * 60 * 60; // 1 hour cache

/**
 * Fetch all providers from models.dev API
 * Results are cached for 1 hour
 */
export async function fetchModelsDevData(): Promise<ModelsDevAPIResponse> {
  const now = Date.now();

  // Return cached data if still valid
  if (cachedData && now - cacheTimestamp < CACHE_TTL) {
    return cachedData;
  }

  const response = await fetch(MODELS_DEV_API_URL);

  if (!response.ok) {
    throw new Error(`Failed to fetch models.dev data: ${response.statusText}`);
  }

  const data = (await response.json()) as ModelsDevAPIResponse;

  // Update cache
  cachedData = data;
  cacheTimestamp = now;

  return data;
}

/**
 * Get all available providers
 */
export async function getProviders(): Promise<ModelsDevProvider[]> {
  const data = await fetchModelsDevData();
  return Object.entries(data).map(([id, provider]) => ({
    ...provider,
    id,
  }));
}

/**
 * Get provider by ID
 */
export async function getProvider(
  providerId: string,
): Promise<ModelsDevProvider | undefined> {
  const data = await fetchModelsDevData();
  const provider = data[providerId];
  return provider ? { ...provider, id: providerId } : undefined;
}

/**
 * Get all available models (flattened from all providers)
 */
export async function getModels(): Promise<ModelsDevModel[]> {
  const data = await fetchModelsDevData();
  const models: ModelsDevModel[] = [];

  for (const [providerId, provider] of Object.entries(data)) {
    for (const [modelId, modelData] of Object.entries(provider.models)) {
      models.push({
        ...modelData,
        id: modelId,
        provider: providerId,
      });
    }
  }

  return models;
}

/**
 * Get model by ID (format: provider/model-name or just model-name)
 */
export async function getModel(
  modelId: string,
): Promise<ModelsDevModel | undefined> {
  const data = await fetchModelsDevData();

  // Try to find the model across all providers
  for (const [providerId, provider] of Object.entries(data)) {
    // Check if model exists directly with this ID
    if (provider.models[modelId]) {
      return {
        ...provider.models[modelId],
        id: modelId,
        provider: providerId,
      };
    }
  }

  return undefined;
}

/**
 * Search models with filters
 */
export interface ModelSearchOptions {
  query?: string; // Search in name and ID
  provider?: string; // Filter by provider
  hasImageInput?: boolean; // Only models supporting image input
  hasAudioInput?: boolean; // Only models supporting audio input
  hasVideoInput?: boolean; // Only models supporting video input
  hasPdfInput?: boolean; // Only models supporting PDF input
  hasToolCall?: boolean; // Only models supporting tool calling
  hasReasoning?: boolean; // Only models with reasoning
  hasStructuredOutput?: boolean; // Only models with structured output
  excludeDeprecated?: boolean; // Exclude deprecated models
  minContextLength?: number; // Minimum context window size
  maxInputCost?: number; // Maximum cost per million input tokens
}

export async function searchModels(
  options: ModelSearchOptions = {},
): Promise<ModelsDevModel[]> {
  let models = await getModels();

  // Apply filters
  if (options.query) {
    const q = options.query.toLowerCase();
    models = models.filter(
      (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
    );
  }

  if (options.provider) {
    models = models.filter((m) => m.provider === options.provider);
  }

  if (options.hasImageInput) {
    models = models.filter((m) => m.modalities.input.includes("image"));
  }

  if (options.hasAudioInput) {
    models = models.filter((m) => m.modalities.input.includes("audio"));
  }

  if (options.hasVideoInput) {
    models = models.filter((m) => m.modalities.input.includes("video"));
  }

  if (options.hasPdfInput) {
    models = models.filter((m) => m.modalities.input.includes("pdf"));
  }

  if (options.hasToolCall) {
    models = models.filter((m) => m.tool_call);
  }

  if (options.hasReasoning) {
    models = models.filter((m) => m.reasoning);
  }

  if (options.hasStructuredOutput) {
    models = models.filter((m) => m.structured_output);
  }

  if (options.excludeDeprecated) {
    models = models.filter((m) => m.status !== "deprecated");
  }

  if (options.minContextLength) {
    models = models.filter((m) => m.limit.context >= options.minContextLength!);
  }

  if (options.maxInputCost) {
    models = models.filter((m) => m.cost.input <= options.maxInputCost!);
  }

  return models;
}

/**
 * Get models by provider
 */
export async function getModelsByProvider(
  providerId: string,
): Promise<ModelsDevModel[]> {
  const data = await fetchModelsDevData();
  const provider = data[providerId];

  if (!provider) {
    return [];
  }

  return Object.entries(provider.models).map(([modelId, modelData]) => ({
    ...modelData,
    id: modelId,
    provider: providerId,
  }));
}

/**
 * Check if a model supports a specific input modality
 */
export function supportsInputModality(
  model: ModelsDevModel,
  modality: InputModality,
): boolean {
  return model.modalities.input.includes(modality);
}

/**
 * Check if a model supports image input
 */
export function supportsImageInput(model: ModelsDevModel): boolean {
  return supportsInputModality(model, "image");
}

/**
 * Check if a model supports audio input
 */
export function supportsAudioInput(model: ModelsDevModel): boolean {
  return supportsInputModality(model, "audio");
}

/**
 * Check if a model supports tool calling
 */
export function supportsToolCalling(model: ModelsDevModel): boolean {
  return model.tool_call;
}

/**
 * Get provider logo URL
 */
export function getProviderLogoUrl(providerId: string): string {
  return `https://models.dev/logos/${providerId}.svg`;
}

/**
 * Map models.dev provider ID to our internal provider type
 */
export function mapProviderToInternal(
  providerId: string,
): "openai" | "openrouter" | "huggingface" | "cloudflare-workers-ai" | null {
  const mapping: Record<
    string,
    "openai" | "openrouter" | "huggingface" | "cloudflare-workers-ai"
  > = {
    openai: "openai",
    anthropic: "openrouter", // Route through OpenRouter
    google: "openrouter", // Route through OpenRouter
    mistral: "openrouter", // Route through OpenRouter
    meta: "openrouter", // Route through OpenRouter
    cohere: "openrouter", // Route through OpenRouter
    deepseek: "openrouter", // Route through OpenRouter
    groq: "openrouter", // Route through OpenRouter
    "together-ai": "openrouter", // Route through OpenRouter
    perplexity: "openrouter", // Route through OpenRouter
    fireworks: "openrouter", // Route through OpenRouter
    "huggingface-inference": "huggingface",
    "cloudflare-workers-ai": "cloudflare-workers-ai",
  };

  return mapping[providerId] ?? null;
}

/**
 * Calculate estimated cost for a request
 */
export function estimateCost(
  model: ModelsDevModel,
  inputTokens: number,
  outputTokens: number,
  reasoningTokens = 0,
): number {
  const inputCost = (inputTokens / 1_000_000) * model.cost.input;
  const outputCost = (outputTokens / 1_000_000) * model.cost.output;
  const reasoningCost =
    model.cost.reasoning && reasoningTokens > 0
      ? (reasoningTokens / 1_000_000) * model.cost.reasoning
      : 0;

  return inputCost + outputCost + reasoningCost;
}

// ─────────────────────────────────────────────────────
// Simplified model capabilities type for DB storage
// ─────────────────────────────────────────────────────

export interface ModelCapabilities {
  inputModalities: InputModality[];
  outputModalities: OutputModality[];
  toolCall: boolean;
  reasoning: boolean;
  structuredOutput: boolean;
  attachment: boolean;
  contextLength: number;
  maxOutputTokens: number;
  costInputPerMillion?: number;
  costOutputPerMillion?: number;
}

/**
 * Extract capabilities from a models.dev model
 */
export function extractCapabilities(model: ModelsDevModel): ModelCapabilities {
  return {
    inputModalities: model.modalities.input,
    outputModalities: model.modalities.output,
    toolCall: model.tool_call,
    reasoning: model.reasoning,
    structuredOutput: model.structured_output ?? false,
    attachment: model.attachment,
    contextLength: model.limit.context,
    maxOutputTokens: model.limit.output,
    costInputPerMillion: model.cost.input,
    costOutputPerMillion: model.cost.output,
  };
}

// ─────────────────────────────────────────────────────
// Model Type Detection
// ─────────────────────────────────────────────────────

/**
 * Detect model type based on family field or naming conventions
 * - Embedding models: family contains "embed" or name/id contains "embed"
 * - Reranker models: name/id contains "rerank"
 * - Chat models: everything else
 */
export type ModelType = "chat" | "embedding" | "reranker";

/**
 * Check if a model is an embedding model
 * Detection based on:
 * 1. family field contains "embed"
 * 2. model name/id contains "embed" (fallback)
 * 3. cost.output === 0 and no tool_call support (heuristic)
 */
export function isEmbeddingModel(model: ModelsDevModel): boolean {
  // Check family field (most reliable)
  if (model.family?.toLowerCase().includes("embed")) {
    return true;
  }

  // Check name/id for "embed" keyword
  const idLower = model.id.toLowerCase();
  const nameLower = model.name.toLowerCase();
  if (idLower.includes("embed") || nameLower.includes("embed")) {
    return true;
  }

  return false;
}

/**
 * Check if a model is a reranker model
 */
export function isRerankerModel(model: ModelsDevModel): boolean {
  const idLower = model.id.toLowerCase();
  const nameLower = model.name.toLowerCase();
  return idLower.includes("rerank") || nameLower.includes("rerank");
}

/**
 * Detect the type of a model
 */
export function detectModelType(model: ModelsDevModel): ModelType {
  if (isEmbeddingModel(model)) return "embedding";
  if (isRerankerModel(model)) return "reranker";
  return "chat";
}

/**
 * Get the embedding dimensions for an embedding model
 * For embedding models, limit.output represents the embedding dimensions
 * Returns undefined for non-embedding models
 */
export function getEmbeddingDimensions(
  model: ModelsDevModel,
): number | undefined {
  if (!isEmbeddingModel(model)) {
    return undefined;
  }
  // For embedding models, limit.output is the vector dimensions
  return model.limit.output;
}

/**
 * Check if a model alias or model ID looks like an embedding model
 * Useful when we don't have full model data from models.dev
 */
export function looksLikeEmbeddingModel(aliasOrModelId: string): boolean {
  const lower = aliasOrModelId.toLowerCase();
  return lower.includes("embed") || lower.includes("bge-");
}

/**
 * Check if a model alias or model ID looks like a reranker model
 */
export function looksLikeRerankerModel(aliasOrModelId: string): boolean {
  const lower = aliasOrModelId.toLowerCase();
  return lower.includes("rerank");
}

/**
 * Detect model type from alias or model ID string
 * Fallback when we don't have full model data
 */
export function detectModelTypeFromString(aliasOrModelId: string): ModelType {
  if (looksLikeEmbeddingModel(aliasOrModelId)) return "embedding";
  if (looksLikeRerankerModel(aliasOrModelId)) return "reranker";
  return "chat";
}

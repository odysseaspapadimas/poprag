/**
 * Seed script for populating initial model aliases
 * Now includes capabilities from models.dev
 * Run with: pnpm db:seed-models
 */

interface ModelCapabilities {
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

interface ModelAliasConfig {
  alias: string;
  provider: "openai" | "openrouter" | "huggingface" | "cloudflare-workers-ai";
  modelId: string;
  modelsDevId?: string; // models.dev ID for fetching capabilities
  capabilities?: ModelCapabilities;
}

const defaultModels: ModelAliasConfig[] = [
  {
    alias: "gpt-4o",
    provider: "openai",
    modelId: "gpt-4o",
    modelsDevId: "openai/gpt-4o",
    capabilities: {
      inputModalities: ["text", "image", "audio"],
      outputModalities: ["text", "audio"],
      toolCall: true,
      reasoning: false,
      structuredOutput: true,
      attachment: true,
      contextLength: 128000,
      maxOutputTokens: 16384,
      costInputPerMillion: 2.5,
      costOutputPerMillion: 10,
    },
  },
  {
    alias: "gpt-4o-mini",
    provider: "openai",
    modelId: "gpt-4o-mini",
    modelsDevId: "openai/gpt-4o-mini",
    capabilities: {
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      toolCall: true,
      reasoning: false,
      structuredOutput: true,
      attachment: true,
      contextLength: 128000,
      maxOutputTokens: 16384,
      costInputPerMillion: 0.15,
      costOutputPerMillion: 0.6,
    },
  },
  {
    alias: "gpt-4.1",
    provider: "openai",
    modelId: "gpt-4.1",
    modelsDevId: "openai/gpt-4.1",
    capabilities: {
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      toolCall: true,
      reasoning: false,
      structuredOutput: true,
      attachment: true,
      contextLength: 1047576,
      maxOutputTokens: 32768,
      costInputPerMillion: 2,
      costOutputPerMillion: 8,
    },
  },
  {
    alias: "o1",
    provider: "openai",
    modelId: "o1",
    modelsDevId: "openai/o1",
    capabilities: {
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      toolCall: true,
      reasoning: true,
      structuredOutput: true,
      attachment: true,
      contextLength: 200000,
      maxOutputTokens: 100000,
      costInputPerMillion: 15,
      costOutputPerMillion: 60,
    },
  },
  {
    alias: "claude-3-5-sonnet",
    provider: "openrouter",
    modelId: "anthropic/claude-3-5-sonnet",
    modelsDevId: "anthropic/claude-3-5-sonnet-20241022",
    capabilities: {
      inputModalities: ["text", "image", "pdf"],
      outputModalities: ["text"],
      toolCall: true,
      reasoning: false,
      structuredOutput: false,
      attachment: true,
      contextLength: 200000,
      maxOutputTokens: 8192,
      costInputPerMillion: 3,
      costOutputPerMillion: 15,
    },
  },
  {
    alias: "claude-3-5-haiku",
    provider: "openrouter",
    modelId: "anthropic/claude-3-5-haiku",
    modelsDevId: "anthropic/claude-3-5-haiku-20241022",
    capabilities: {
      inputModalities: ["text", "image", "pdf"],
      outputModalities: ["text"],
      toolCall: true,
      reasoning: false,
      structuredOutput: false,
      attachment: true,
      contextLength: 200000,
      maxOutputTokens: 8192,
      costInputPerMillion: 0.8,
      costOutputPerMillion: 4,
    },
  },
  {
    alias: "embedding-default",
    provider: "openai",
    modelId: "text-embedding-3-small",
    modelsDevId: "openai/text-embedding-3-small",
    capabilities: {
      inputModalities: ["text"],
      outputModalities: ["text"],
      toolCall: false,
      reasoning: false,
      structuredOutput: false,
      attachment: false,
      contextLength: 8191,
      maxOutputTokens: 0,
      costInputPerMillion: 0.02,
      costOutputPerMillion: 0,
    },
  },
  {
    alias: "embedding-large",
    provider: "openai",
    modelId: "text-embedding-3-large",
    modelsDevId: "openai/text-embedding-3-large",
    capabilities: {
      inputModalities: ["text"],
      outputModalities: ["text"],
      toolCall: false,
      reasoning: false,
      structuredOutput: false,
      attachment: false,
      contextLength: 8191,
      maxOutputTokens: 0,
      costInputPerMillion: 0.13,
      costOutputPerMillion: 0,
    },
  },
];

function generateSeedSQL() {
  const statements = [];

  // Delete dependent records first (foreign key constraints)
  statements.push("DELETE FROM agent_model_policy;");

  // Now safe to delete all existing model aliases
  statements.push("DELETE FROM model_alias;");

  for (const model of defaultModels) {
    const capsJson = model.capabilities
      ? JSON.stringify(model.capabilities).replace(/'/g, "''")
      : null;

    const sql = capsJson
      ? `INSERT OR REPLACE INTO model_alias (alias, provider, model_id, capabilities, updated_at) VALUES ('${model.alias}', '${model.provider}', '${model.modelId}', '${capsJson}', datetime('now'));`
      : `INSERT OR REPLACE INTO model_alias (alias, provider, model_id, updated_at) VALUES ('${model.alias}', '${model.provider}', '${model.modelId}', datetime('now'));`;

    statements.push(sql);
  }

  return statements.join("\n");
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(generateSeedSQL());
}

export { defaultModels, generateSeedSQL };

/**
 * Seed script for populating initial model aliases
 * Run with: pnpm db:seed-models
 */

const defaultModels = [
  {
    alias: "gpt-4o",
    provider: "openai" as const,
    modelId: "gpt-4o",
  },
  {
    alias: "gpt-4o-mini",
    provider: "openai" as const,
    modelId: "gpt-4o-mini",
  },
  {
    alias: "gpt-3.5-turbo",
    provider: "openai" as const,
    modelId: "gpt-3.5-turbo",
  },
  {
    alias: "embedding-default",
    provider: "openai" as const,
    modelId: "text-embedding-3-small",
  },
  {
    alias: "embedding-large",
    provider: "openai" as const,
    modelId: "text-embedding-3-large",
  },
];

function generateSeedSQL() {
  const statements = [];

  for (const model of defaultModels) {
    const sql = `INSERT OR REPLACE INTO model_alias (alias, provider, model_id, updated_at) VALUES ('${model.alias}', '${model.provider}', '${model.modelId}', datetime('now'));`;
    statements.push(sql);
  }

  return statements.join("\n");
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(generateSeedSQL());
}

export { generateSeedSQL };

/**
 * Seed script for populating initial model aliases
 * Run with: pnpm db:seed-models
 */

const defaultModels = [
	{
		alias: "gpt-4o",
		provider: "openai" as const,
		modelId: "gpt-4o",
		caps: {
			maxTokens: 4096,
			maxPricePer1k: 15,
			streaming: true,
		},
	},
	{
		alias: "gpt-4o-mini",
		provider: "openai" as const,
		modelId: "gpt-4o-mini",
		caps: {
			maxTokens: 4096,
			maxPricePer1k: 0.6,
			streaming: true,
		},
	},
	{
		alias: "gpt-3.5-turbo",
		provider: "openai" as const,
		modelId: "gpt-3.5-turbo",
		caps: {
			maxTokens: 4096,
			maxPricePer1k: 1.5,
			streaming: true,
		},
	},
	{
		alias: "embedding-default",
		provider: "openai" as const,
		modelId: "text-embedding-3-small",
		caps: {
			maxTokens: 8191,
			maxPricePer1k: 0.02,
		},
	},
	{
		alias: "embedding-large",
		provider: "openai" as const,
		modelId: "text-embedding-3-large",
		caps: {
			maxTokens: 8191,
			maxPricePer1k: 0.13,
		},
	},
];

function generateSeedSQL() {
	const statements = [];

	for (const model of defaultModels) {
		const capsJson = JSON.stringify(model.caps);
		const sql = `INSERT OR REPLACE INTO model_alias (alias, provider, model_id, caps, updated_at) VALUES ('${model.alias}', '${model.provider}', '${model.modelId}', json('${capsJson.replace(/'/g, "''")}'), datetime('now'));`;
		statements.push(sql);
	}

	return statements.join('\n');
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
	console.log(generateSeedSQL());
}

export { generateSeedSQL };

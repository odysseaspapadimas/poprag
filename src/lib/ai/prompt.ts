/**
 * Prompt template renderer with variable substitution
 * Supports simple {{variable}} syntax
 */
export function renderPrompt(
	template: string,
	variables: Record<string, unknown>,
): string {
	let rendered = template;

	for (const [key, value] of Object.entries(variables)) {
		const placeholder = `{{${key}}}`;
		const replacement = String(value);
		rendered = rendered.replaceAll(placeholder, replacement);
	}

	return rendered;
}

/**
 * Extract variables from a template string
 * Returns array of variable names found in {{variable}} syntax
 */
export function extractVariables(template: string): string[] {
	const regex = /\{\{(\w+)\}\}/g;
	const matches = template.matchAll(regex);
	return Array.from(matches, (match) => match[1]);
}

/**
 * Validate that all required variables are provided
 */
export function validateVariables(
	template: string,
	variables: Record<string, unknown>,
): { valid: boolean; missing: string[] } {
	const required = extractVariables(template);
	const provided = Object.keys(variables);
	const missing = required.filter((key) => !provided.includes(key));

	return {
		valid: missing.length === 0,
		missing,
	};
}

/**
 * Build system prompt with context injection for RAG
 */
export function buildSystemPrompt(
	basePrompt: string,
	context?: {
		chunks?: Array<{
			content: string;
			sourceId: string;
			score: number;
			metadata?: Record<string, unknown>;
		}>;
		guardrails?: {
			moderation?: boolean;
			denylist?: string[];
		};
	},
): string {
	let prompt = basePrompt;

	// Inject RAG context if available
	if (context?.chunks && context.chunks.length > 0) {
		const contextBlock = `

## Knowledge Base Context
The following information is from your knowledge base. Use it to answer questions accurately:

${context.chunks
	.map(
		(chunk, idx) =>
			`[${idx + 1}] (source: ${chunk.sourceId}, relevance: ${(chunk.score * 100).toFixed(1)}%)
${chunk.content}`,
	)
	.join("\n\n")}

Remember to cite sources using [source: <sourceId>] format when referencing this information.
`;
		prompt += contextBlock;
	}

	// Add guardrail instructions
	if (context?.guardrails?.moderation) {
		prompt += "\n\nIMPORTANT: Do not generate harmful, inappropriate, or offensive content.";
	}

	if (context?.guardrails?.denylist && context.guardrails.denylist.length > 0) {
		prompt += `\n\nDo not respond to queries about: ${context.guardrails.denylist.join(", ")}.`;
	}

	return prompt;
}

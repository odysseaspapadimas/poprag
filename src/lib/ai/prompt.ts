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
 * Build complete system prompt with RAG context
 * Following best practices for RAG prompt engineering
 */
export function buildSystemPrompt(
	basePrompt: string,
	ragContext: {
		chunks: Array<{
			content: string;
			sourceId: string;
			score: number;
			metadata?: Record<string, unknown>;
		}>;
	},
): string {
	if (!ragContext.chunks.length) return basePrompt;

	// Sort by relevance score (highest first)
	const sortedChunks = [...ragContext.chunks].sort((a, b) => b.score - a.score);

	const contextSection = sortedChunks
		.map(
			(chunk, idx) =>
				`[Context ${idx + 1}] Relevance: ${chunk.score.toFixed(3)} | Source: ${chunk.metadata?.fileName || chunk.sourceId}
${chunk.content}`,
		)
		.join("\n\n" + "═".repeat(80) + "\n\n");

	return `${basePrompt}

${'═'.repeat(80)}
## 📚 Retrieved Knowledge Base Context
${'═'.repeat(80)}

The following information has been retrieved from your knowledge base based on semantic similarity to the current conversation. This context is specifically relevant to answering the user's questions.

**Instructions for using this context:**
1. Prioritize information with higher relevance scores (closer to 1.0)
2. Always cite the source when referencing specific information (e.g., "According to [Source Name]...")
3. If the context doesn't fully answer the question, acknowledge this and use the getInformation tool to search for more specific information
4. Cross-reference multiple context chunks when they provide complementary information
5. If context contradicts your training data, prioritize the retrieved context as it represents current project-specific information

${'═'.repeat(80)}
${contextSection}
${'═'.repeat(80)}

**Context Usage Guidelines:**
- High relevance (0.8-1.0): Very likely to be accurate and directly relevant
- Medium relevance (0.6-0.8): Likely relevant but verify before using
- Lower relevance (0.5-0.6): May contain useful information but use with caution

If you need more specific information, use the getInformation tool with a focused query.`;
}
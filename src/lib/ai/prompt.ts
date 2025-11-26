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
      (chunk) =>
        `---
Source: ${chunk.metadata?.fileName || chunk.sourceId}
Relevance: ${chunk.score.toFixed(3)}
Content:
${chunk.content}
---`,
    )
    .join("\n\n");

  return `${basePrompt}

${"═".repeat(80)}
## 📚 Retrieved Knowledge Base Context
${"═".repeat(80)}

The following information has been retrieved from your knowledge base. Use it to answer the user's question.

**Instructions:**
1. **Answer based ONLY on the provided context.** If the answer is not in the context, say so.
2. **Cite your sources.** When using information, reference the source filename (e.g., "According to [filename]...").
3. **Handle missing data gracefully.** If a number or unit is missing (e.g., "g" instead of "200g"), do NOT output the partial data. State that the specific value is missing from the context.
4. **Do NOT mention "Context 1", "Context 2", etc.** Refer to the source filenames.
5. **Formatting:** Present lists clearly.

${"═".repeat(80)}
${contextSection}
${"═".repeat(80)}
`;
}

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
    .map((chunk) => chunk.content)
    .join("\n\n---\n\n");

  return `${basePrompt}

## Reference Information

The following information is available to help you answer the user's question:

${contextSection}

---

**Important guidelines:**
- Base your answer ONLY on the reference information provided above.
- If the reference information does not contain sufficient information to answer the question, clearly state that you don't have that information.
- Do NOT supplement the reference information with your own knowledge unless the user's question is clearly general knowledge that doesn't require specific documents.
- NEVER mention documents, files, sources, PDFs, or that you retrieved this information.
- NEVER say things like "According to the document..." or "Based on the file...".
- Answer naturally as if the reference information were your own knowledge.
- If data appears incomplete (e.g., missing numbers or units), acknowledge you don't have that specific detail.
- Always provide complete answers - do not cut off mid-sentence.
`;
}

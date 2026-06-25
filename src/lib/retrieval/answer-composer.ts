import type {
  CatalogEvidence,
  CatalogFieldCapability,
  DocumentEvidence,
} from "./types";

export function buildRetrievalSystemPrompt(
  basePrompt: string,
  retrieval: {
    catalogEvidence?: CatalogEvidence;
    documentEvidence?: DocumentEvidence | null;
  },
): string {
  const sections = [
    formatCatalogEvidence(retrieval.catalogEvidence),
    formatDocumentEvidence(retrieval.documentEvidence),
  ].filter(Boolean);

  if (sections.length === 0) return basePrompt;

  return `${basePrompt}

## Private Reference Information

Use this private product/reference information to answer the user's question naturally:

${sections.join("\n\n---\n\n")}

---

**How to answer:**
- Speak like a helpful product assistant. Use simple retail language.
- Base your answer ONLY on the private reference information above.
- Product data is authoritative for availability, counts, browsing groups, product facts, and product lists.
- Only product data may be used for product availability, count, or list claims; never infer those claims from detail text.
- Detail text may help answer ingredients, usage, warnings, recommendations, comparisons, and other descriptive questions.
- If the private reference information does not contain enough detail, clearly say that you don't have that information.
- Do not proactively offer comparisons, recommendations, or alternatives unless the user explicitly asks and the private reference information contains the products needed.
- If the user asks for categories but only brand-like/product-group values are shown, say you can browse by those brands/product groups; do not call them categories.
- Do not mention implementation/debug wording. Speak only in customer-facing language.
- When additional products are available, say "more products" or "more results".
- Always provide complete answers - do not cut off mid-sentence.
`;
}

function formatCatalogEvidence(evidence: CatalogEvidence | undefined) {
  if (!evidence) return "";

  const lines = ["### Product Data"];

  switch (evidence.kind) {
    case "overview":
      lines.push(
        "Information type: product overview",
        `Total products available: ${evidence.totalActiveProducts}`,
        ...formatFieldCapabilities(evidence.fieldCapabilities),
        ...formatFilterValueSummaries(evidence.filterValueSummaries, 24),
        "Answer with a short overview. Do not list individual products unless the user explicitly asked for product names.",
        "Do not proactively offer comparisons, recommendations, or alternatives from an overview.",
        "These are browsing groups from catalog fields, not necessarily retail categories.",
      );
      break;
    case "capabilities":
      lines.push(
        "Information type: product browsing options",
        `Total products available: ${evidence.totalActiveProducts}`,
        evidence.requestedField ? "The user asked about browsing options." : "",
        ...formatFieldCapabilities(evidence.fieldCapabilities),
        ...formatFilterValueSummaries(evidence.filterValueSummaries),
        "Answer only from these available browsing groups and values. Do not invent groups or values.",
        "Do not proactively offer comparisons, recommendations, or alternatives from browsing options.",
        "These are browsing groups from catalog fields, not necessarily retail categories.",
      );
      break;
    case "count":
      lines.push(
        "Information type: product count",
        `User asked about: ${formatEvidenceSubject(evidence)}`,
        `Total products available: ${evidence.totalActiveProducts}`,
        `Matching products: ${evidence.matchedProducts}`,
        "Answer the count directly from the matching products value.",
      );
      break;
    case "product_page":
      lines.push(
        "Information type: product list",
        `User asked about: ${formatEvidenceSubject(evidence)}`,
        `Total products available: ${evidence.totalActiveProducts}`,
        `Matching products: ${evidence.matchedProducts}`,
        `Products shown now: ${evidence.products.length}`,
        `More matching products are available: ${evidence.hasMore ? "yes" : "no"}`,
        "Products to show:",
        ...evidence.products.map(
          (product, index) =>
            `${evidence.offset + index + 1}. ${product.title}${formatFacts(product.facts)}`,
        ),
        "List every product under Products to show unless the user explicitly asked for fewer products. Do not summarize a longer product list down to fewer items.",
        "Show only these products for now. If more products are available, ask whether the user wants to see more.",
        "Do not proactively offer comparisons or alternatives. You may say the user can ask for details about a listed product.",
      );
      break;
    case "product_detail":
      lines.push(
        "Information type: product facts",
        `Total products available: ${evidence.totalActiveProducts}`,
        `Validated products provided: ${evidence.products.length}`,
        "Products provided:",
        ...evidence.products.map(
          (product, index) =>
            `${index + 1}. ${product.title}${formatFacts(product.facts)}`,
        ),
        "If the user explicitly asked to compare and at least two products are provided, compare only these products.",
        "If the user explicitly asked to compare but fewer than two products are provided, say which product you have and ask which other product to compare; do not claim the other product is unavailable unless no matching product data was provided.",
        "If the user did not ask to compare, do not offer comparisons, recommendations, or alternatives.",
      );
      break;
    case "product_clarification":
      lines.push(
        "Information type: product clarification needed",
        `Total products available: ${evidence.totalActiveProducts}`,
        evidence.message,
        ...evidence.references.flatMap((reference, index) => [
          `Requested product ${index + 1}: ${formatProductReference(reference.requested)}`,
          "Matching candidates:",
          ...reference.candidates.map(
            (product, productIndex) =>
              `${productIndex + 1}. ${product.title}${formatFacts(product.facts)}`,
          ),
        ]),
        "Ask the user which exact product they mean. Do not compare or choose one until the user clarifies.",
      );
      break;
    case "no_match":
      lines.push(
        "Information type: no matching products",
        `User asked about: ${formatTerms(evidence.terms) || "unspecified products"}`,
        `Total products available: ${evidence.totalActiveProducts}`,
        "No products were found for this request.",
        "Do not say matching products are available. You may ask the user to try another brand, product type, or name.",
      );
      break;
  }

  return lines.filter(Boolean).join("\n");
}

function formatDocumentEvidence(evidence: DocumentEvidence | null | undefined) {
  if (!evidence?.chunks.length) return "";

  const sortedChunks = [...evidence.chunks].sort((a, b) => b.score - a.score);
  return [
    "### Detail Text",
    ...sortedChunks.map((chunk, index) => {
      return `Detail ${index + 1}:\n${chunk.content}`;
    }),
  ].join("\n\n");
}

function formatFieldCapabilities(capabilities: CatalogFieldCapability[]) {
  const hasRole = (role: string) =>
    capabilities.some((capability) => capability.role === role);

  const options = [
    hasRole("filterable") ? "browsing groups such as brands" : "",
    hasRole("title") ? "product names" : "",
    hasRole("stable_key") || hasRole("exact") ? "product codes" : "",
    hasRole("searchable") ? "product details" : "",
  ].filter(Boolean);

  return [
    `Useful ways to ask: ${options.length > 0 ? options.join(", ") : "product names"}`,
  ];
}

function formatFilterValueSummaries(
  summaries: Array<{
    fieldPath: string;
    value: string;
    productCount: number;
  }>,
  maxValuesPerField = 80,
) {
  if (summaries.length === 0) {
    return ["Available browsing groups: none"];
  }

  const grouped = groupSummariesByFieldPath(summaries);
  const lines: string[] = [];
  let remainingBudget = maxValuesPerField;
  for (const [fieldPath, values] of grouped) {
    if (remainingBudget <= 0) break;
    const displayedValues = values
      .slice(0, remainingBudget)
      .map((summary) => `${summary.value} (${summary.productCount})`);
    const remainingCount = values.length - displayedValues.length;
    lines.push(
      `${formatGroupFieldLabel(fieldPath)}: ${displayedValues.join(", ")}${
        remainingCount > 0 ? `, and ${remainingCount} more` : ""
      }`,
    );
    remainingBudget -= displayedValues.length;
  }

  return lines;
}

function groupSummariesByFieldPath(
  summaries: Array<{
    fieldPath: string;
    value: string;
    productCount: number;
  }>,
) {
  const grouped = new Map<string, typeof summaries>();
  for (const summary of summaries) {
    const group = grouped.get(summary.fieldPath) ?? [];
    group.push(summary);
    grouped.set(summary.fieldPath, group);
  }
  return grouped;
}

function formatGroupFieldLabel(fieldPath: string) {
  const normalized = fieldPath.toLocaleLowerCase();
  if (normalized.includes("category")) return "Available categories";
  if (normalized.includes("brand") || normalized.includes("documentsummary")) {
    return "Available brands/product groups";
  }
  return "Available browsing groups";
}

function formatEvidenceSubject(evidence: {
  terms: Array<{ value: string; fieldPath?: string }>;
  scopeLabel?: string;
}) {
  const terms = formatTerms(evidence.terms);
  if (terms) return terms;
  if (evidence.scopeLabel) return `${evidence.scopeLabel} catalog scope`;
  return "all products";
}

function formatProductReference(reference: {
  title?: string;
  terms?: Array<{ value: string; fieldPath?: string }>;
  productId?: string;
}) {
  return (
    reference.title ||
    formatTerms(reference.terms ?? []) ||
    reference.productId ||
    "unspecified product"
  );
}

function formatTerms(terms: Array<{ value: string; fieldPath?: string }>) {
  return terms.map((term) => term.value).join(", ");
}

function formatFacts(facts: Array<{ fieldPath: string; value: string }>) {
  const text = facts
    .map((fact) => `${formatFactLabel(fact.fieldPath)}: ${fact.value}`)
    .join("; ");
  return text ? ` (${text})` : "";
}

function formatFactLabel(fieldPath: string) {
  if (fieldPath === "recordKey") return "code";

  const normalized = fieldPath
    .replace(/\.(el-GR|en-GB)$/u, "")
    .split(".")
    .at(-1)
    ?.replace(/[-_]+/gu, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLocaleLowerCase()
    .trim();

  return normalized || "detail";
}

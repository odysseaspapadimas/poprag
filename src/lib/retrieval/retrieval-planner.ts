import { generateText, type LanguageModel } from "ai";
import { normalizeCatalogValue } from "@/lib/catalog/shared";
import type {
  CatalogProductReference,
  CatalogSearchTerm,
  PlannerDiagnostics,
  RetrievalCatalogFocus,
  RetrievalCatalogProductFocus,
  RetrievalPageCursor,
  RetrievalPlan,
  SourceCapabilities,
} from "./types";

export async function planRetrieval(
  model: LanguageModel | null,
  options: {
    modelId: string;
    userMessage: string;
    effectiveQuery: string;
    capabilities: SourceCapabilities;
    previousCatalogPage?: RetrievalPageCursor;
    previousCatalogFocus?: RetrievalCatalogFocus;
    previousCatalogProductFocus?: RetrievalCatalogProductFocus;
    generatePlannerText?: (options: {
      prompt: string;
      temperature: number;
      maxOutputTokens: number;
      abortSignal: AbortSignal;
    }) => Promise<string>;
  },
): Promise<{ plan: RetrievalPlan; diagnostics: PlannerDiagnostics }> {
  const continuationPlan = planCatalogContinuationFromRawMessage(options);
  if (continuationPlan) {
    return {
      plan: continuationPlan,
      diagnostics: {
        attempted: false,
        planKind: continuationPlan.kind,
        reason: continuationPlan.reason,
      },
    };
  }

  const focusListPlan = planCatalogFocusListFromRawMessage(options);
  if (focusListPlan) {
    return {
      plan: focusListPlan,
      diagnostics: {
        attempted: false,
        planKind: focusListPlan.kind,
        reason: focusListPlan.reason,
      },
    };
  }

  const fallback = fallbackPlan(options.capabilities);

  try {
    const prompt = buildPlannerPrompt(options);
    const abortSignal = AbortSignal.timeout(2200);
    const text = options.generatePlannerText
      ? await options.generatePlannerText({
          prompt,
          temperature: 0,
          maxOutputTokens: 260,
          abortSignal,
        })
      : await generatePlannerTextWithModel(model, {
          prompt,
          temperature: 0,
          maxOutputTokens: 260,
          abortSignal,
        });

    const parsed = parsePlannerText(text);
    const normalized = normalizeGenericCatalogTerms(
      parsed,
      options.userMessage,
      options.capabilities,
      options.previousCatalogFocus,
    );
    const rawCandidatePlan = addRawUserValidationCandidates(
      normalized,
      options.userMessage,
    );
    const plan = constrainPlanToCapabilities(
      rawCandidatePlan,
      options.capabilities,
    );

    return {
      plan,
      diagnostics: {
        attempted: true,
        model: options.modelId,
        planKind: plan.kind,
        reason: plan.reason,
        rawText: text,
      },
    };
  } catch (error) {
    const isTimeout =
      error instanceof DOMException && error.name === "AbortError";
    return {
      plan: fallback,
      diagnostics: {
        attempted: true,
        model: options.modelId,
        planKind: fallback.kind,
        reason: fallback.reason,
        fallbackReason: isTimeout ? "planner_timeout" : "planner_invalid_json",
      },
    };
  }
}

async function generatePlannerTextWithModel(
  model: LanguageModel | null,
  options: {
    prompt: string;
    temperature: number;
    maxOutputTokens: number;
    abortSignal: AbortSignal;
  },
): Promise<string> {
  if (!model) {
    throw new Error("Retrieval planner model is required");
  }

  const { text } = await generateText({
    model,
    prompt: options.prompt,
    temperature: options.temperature,
    maxOutputTokens: options.maxOutputTokens,
    abortSignal: options.abortSignal,
  });

  return text;
}

function planCatalogContinuationFromRawMessage(options: {
  userMessage: string;
  previousCatalogPage?: RetrievalPageCursor;
}): RetrievalPlan | undefined {
  if (!options.previousCatalogPage?.hasMore) return undefined;
  if (!isShortContinuationMessage(options.userMessage)) return undefined;
  return {
    kind: "catalog_continue",
    reason: "Short confirmation continues the previous catalog page",
  };
}

function planCatalogFocusListFromRawMessage(options: {
  userMessage: string;
  previousCatalogFocus?: RetrievalCatalogFocus;
}): RetrievalPlan | undefined {
  const focus = options.previousCatalogFocus;
  if (!focus) return undefined;
  if (!isShortFocusListMessage(options.userMessage)) return undefined;
  if (focus.terms.length === 0 && !focus.scopeSourceIds?.length) {
    return undefined;
  }

  return {
    kind: "catalog_search",
    reason: "Short follow-up asks to list the previous catalog focus",
    terms: focus.terms,
    pageAction: "first",
    allProducts: focus.terms.length === 0,
    scopeSourceIds: focus.scopeSourceIds,
  };
}

const CONTINUATION_MESSAGE_TOKENS = new Set([
  "continue",
  "more",
  "next",
  "ok",
  "okay",
  "sure",
  "y",
  "yeah",
  "yep",
  "yes",
  "αλλα",
  "επομενα",
  "ναι",
  "οκ",
  "περισσοτερα",
  "συνεχεια",
]);

function isShortContinuationMessage(message: string) {
  const tokens = tokenizeCatalogMessage(message);

  return (
    tokens.length > 0 &&
    tokens.length <= 3 &&
    tokens.every((token) => CONTINUATION_MESSAGE_TOKENS.has(token))
  );
}

const FOCUS_LIST_MESSAGE_TOKENS = new Set([
  "list",
  "ones",
  "show",
  "them",
  "which",
  "αυτα",
  "αυτεσ",
  "δειξε",
  "ειναι",
  "εμφανισε",
  "ποια",
  "ποιεσ",
  "ποιοι",
]);

function isShortFocusListMessage(message: string) {
  const tokens = tokenizeCatalogMessage(message);
  return (
    tokens.length > 0 &&
    tokens.length <= 5 &&
    tokens.every((token) => FOCUS_LIST_MESSAGE_TOKENS.has(token)) &&
    tokens.some((token) =>
      [
        "which",
        "ones",
        "them",
        "ποια",
        "ποιεσ",
        "ποιοι",
        "αυτα",
        "αυτεσ",
      ].includes(token),
    )
  );
}

function tokenizeCatalogMessage(message: string) {
  return normalizeCatalogValue(message)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function buildPlannerPrompt(options: {
  userMessage: string;
  effectiveQuery: string;
  capabilities: SourceCapabilities;
  previousCatalogPage?: RetrievalPageCursor;
  previousCatalogFocus?: RetrievalCatalogFocus;
  previousCatalogProductFocus?: RetrievalCatalogProductFocus;
}) {
  const catalog = options.capabilities.catalog;
  const documents = options.capabilities.documents;
  const filterFields = catalog.fieldCapabilities
    .filter((field) => field.role === "filterable")
    .map((field) => field.fieldPath);
  const lookupFields = catalog.fieldCapabilities
    .filter((field) => ["stable_key", "title", "exact"].includes(field.role))
    .map((field) => field.fieldPath);
  const searchableFields = catalog.fieldCapabilities
    .filter((field) => field.role === "searchable")
    .map((field) => field.fieldPath);
  const valueSamples = catalog.filterValueSummaries
    .slice(0, 80)
    .map((item) => ({
      fieldPath: item.fieldPath,
      value: item.value,
      productCount: item.productCount,
    }));
  const catalogScopes = catalog.scopes.map((scope) => ({
    sourceId: scope.sourceId,
    name: scope.name ?? scope.aliases[0],
    aliases: scope.aliases,
  }));

  return `You are a retrieval planner. You are not answering the user.
Choose which retrieval capabilities should be used for the latest user message.
The user may write in any language. Preserve user-provided names, brands, categories, product types, SKUs, and search terms exactly as written.

Capabilities JSON:
${JSON.stringify({
  catalog: {
    available: catalog.available,
    activeProductCount: catalog.activeProductCount,
    filterFields,
    lookupFields,
    searchableFields,
    filterValueSamples: valueSamples,
    catalogScopes,
  },
  documents: documents,
  previousCatalogPage: options.previousCatalogPage ?? null,
  previousCatalogFocus: options.previousCatalogFocus ?? null,
  previousCatalogProductFocus: options.previousCatalogProductFocus ?? null,
})}

Latest user message JSON: ${JSON.stringify(options.userMessage)}
Standalone search query JSON: ${JSON.stringify(options.effectiveQuery)}

Plan kinds:
- catalog_overview: user asks what products/items/catalog inventory are available in a broad whole-catalog way, without naming a product type, brand, category, SKU, or other subset.
- catalog_search: user asks whether a catalog contains products matching terms, names a product type/category/brand/SKU/search term, asks to show/list matching catalog products, or asks an elliptical follow-up that should list products from the previous catalog focus. Set pageAction to first, next, or restart.
- catalog_count: user asks how many catalog products match.
- catalog_capabilities: user asks what catalog fields, filters, values, brands, categories, or browsing options are available.
- catalog_continue: user is asking to continue the previous catalog page.
- catalog_detail: user asks for facts, identifiers, metadata, or comparison of concrete catalog products. Use this for product comparisons only when the user explicitly asks to compare.
- document_retrieval: user asks for descriptive/detail/explanatory information that should come from ordinary documents or product-detail chunks.
- mixed: user needs both catalog availability/list/count and document detail retrieval.
- none: no knowledge retrieval is needed.

Safety:
- Catalog plans are only plans. A database validator will decide whether terms, counts, fields, and products actually exist.
- Use catalog plans, not document_retrieval, for catalog availability, count, or product-list claims.
- If no catalog capability is available, do not choose catalog_* plans.
- If no document capability is available, do not choose document_retrieval.
- A catalog_search term must name a specific product, brand, category, product type, SKU, or other searchable value. Generic words like products, items, catalog, inventory, or "what do you have" in any language are not actionable search terms.
- Configured catalogScopes are owner/supplier/portfolio names for the whole catalog, not visible product brands/categories/filter values. If the user asks for products from one of those aliases, treat it as the whole catalog scope: use catalog_search with no terms for show/list requests, catalog_count with no terms for count requests, or catalog_overview for broad overview requests. Do not emit a literal term equal to a configured catalog scope alias.
- For catalog_search and catalog_count, extract the shortest useful terms. Do not translate or transliterate them.
- For catalog_continue, only choose it when the message naturally continues the previous page state.
- When a message asks for more/another/next results from the previous catalog page, choose catalog_search with pageAction="next" and reuse the previous catalog focus terms unless the user clearly changes topic.
- When previousCatalogFocus is present and the latest message is an elliptical follow-up asking to see/list/identify those products without naming a new term, choose catalog_search using previousCatalogFocus.terms. Do not broaden to catalog_overview unless the user clearly resets to the whole catalog.
- When previousCatalogProductFocus has the concrete products needed for an explicit comparison/detail follow-up, choose catalog_detail with those productIds. Do not turn comparison into catalog_search with intersected terms.
- In catalog_detail products, productId is only a candidate. Always include the user-facing requested product label in title or terms so the database validator can reject a mismatched productId.
- Do not choose catalog_detail for ingredients, usage, warnings, recommendations, policies, or explanatory questions unless the needed product facts are present in catalog fields; choose document_retrieval or mixed instead.

Semantic examples:
- A broad question asking what products/items the catalog carries without a subset -> catalog_overview.
- A question asking what products of a named product type/category/brand/search term are available -> catalog_search with that term. Examples: "what cleaning products do you have?", "τι καθαριστικά έχεις;", "εχεις αποσμητικά;", "για ψάξε για αφρόλουτρα".
- A question asking whether the catalog has a product type, brand, category, SKU, or search term -> catalog_search with that term.
- A command to show or list products matching a brand/category/type -> catalog_search with that term.
- A command to show or list products from a configured catalog scope alias -> catalog_search with no terms, because the alias means all products in this catalog rather than a matched field value.
- A question asking how many products match -> catalog_count with matching terms, or no terms for total catalog count.
- A short confirmation or request for more after a previous page with more results -> catalog_search with pageAction="next", or catalog_continue for very short confirmations.
- A follow-up like "which ones?" after a catalog count for a brand/type -> catalog_search with the previous catalog focus terms.
- A follow-up like "compare them" after a prior answer showed two concrete products -> catalog_detail with both previous productIds.
- A direct request for SKU, GTIN, barcode, product name, or other catalog record facts -> catalog_detail.
- A question asking for ingredients, usage, warnings, recommendations, policies, instructions, or explanatory details -> document_retrieval, or mixed if availability/listing is also needed.

Respond ONLY with valid JSON:
{
  "kind": "catalog_overview" | "catalog_search" | "catalog_count" | "catalog_capabilities" | "catalog_continue" | "catalog_detail" | "document_retrieval" | "mixed" | "none",
  "reason": "short reason",
  "terms": [{"value": "term", "fieldPath": "optional configured field"}],
  "pageAction": "first" | "next" | "restart",
  "products": [{"productId": "candidate previous product id", "title": "user-facing requested product label", "terms": [{"value": "fallback term", "fieldPath": "optional configured field"}]}],
  "requestedField": "optional field",
  "plans": []
}`;
}

function parsePlannerText(text: string): RetrievalPlan {
  const jsonText = text
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?\s*```$/i, "");
  const parsed = JSON.parse(jsonText) as Record<string, unknown>;
  return parsePlannerObject(parsed);
}

function parsePlannerObject(parsed: Record<string, unknown>): RetrievalPlan {
  const kind = String(parsed.kind ?? "none");
  const reason = String(parsed.reason ?? "No reason provided");
  const terms = parseTerms(parsed.terms);

  switch (kind) {
    case "catalog_overview":
      return { kind, reason };
    case "catalog_search":
      return {
        kind,
        reason,
        terms,
        limit: parsePositiveInteger(parsed.limit),
        pageAction: parsePageAction(parsed.pageAction),
      };
    case "catalog_count":
      return { kind, reason, terms };
    case "catalog_capabilities":
      return {
        kind,
        reason,
        requestedField:
          typeof parsed.requestedField === "string"
            ? parsed.requestedField.trim() || undefined
            : undefined,
      };
    case "catalog_continue":
      return { kind, reason };
    case "catalog_detail":
      return {
        kind,
        reason,
        products: parseProductReferences(parsed.products, parsed.terms),
      };
    case "document_retrieval":
      return {
        kind,
        reason,
        query:
          typeof parsed.query === "string"
            ? parsed.query.trim() || undefined
            : undefined,
      };
    case "mixed": {
      const plans = Array.isArray(parsed.plans)
        ? parsed.plans
            .filter(
              (item): item is Record<string, unknown> =>
                typeof item === "object" && item !== null,
            )
            .map(parsePlannerObject)
            .filter((plan) => plan.kind !== "mixed")
            .slice(0, 3)
        : [];
      return { kind, reason, plans };
    }
    default:
      return { kind: "none", reason };
  }
}

function parseTerms(value: unknown): CatalogSearchTerm[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value
    .map((item) => {
      if (typeof item === "string") return { value: item.trim() };
      if (typeof item !== "object" || item === null) return null;
      const record = item as Record<string, unknown>;
      const term = String(record.value ?? "").trim();
      if (!term) return null;
      return {
        value: term,
        fieldPath:
          typeof record.fieldPath === "string"
            ? record.fieldPath.trim() || undefined
            : undefined,
      };
    })
    .filter((item): item is CatalogSearchTerm => item !== null)
    .filter((item) => {
      const key = `${item.fieldPath ?? "*"}:${item.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
}

function parseProductReferences(
  value: unknown,
  fallbackTerms: unknown,
): CatalogProductReference[] {
  const seen = new Set<string>();
  const parsed: CatalogProductReference[] = [];
  const products = Array.isArray(value) ? value : [];

  const addReference = (reference: CatalogProductReference) => {
    const key = normalizeCatalogValue(
      reference.productId ??
        reference.title ??
        (reference.terms ?? [])
          .map((term) => `${term.fieldPath ?? "*"}:${term.value}`)
          .join("|"),
    );
    if (!key || seen.has(key)) return;
    seen.add(key);
    parsed.push(reference);
  };

  for (const item of products) {
    if (parsed.length >= 8) break;

    if (typeof item === "string") {
      const title = item.trim();
      if (title) addReference({ title, terms: [{ value: title }] });
      continue;
    }

    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const productId =
      typeof record.productId === "string"
        ? record.productId.trim() || undefined
        : undefined;
    const title =
      typeof record.title === "string"
        ? record.title.trim() || undefined
        : undefined;
    const terms = parseTerms(record.terms);
    if (!productId && !title && terms.length === 0) continue;

    addReference({
      ...(productId ? { productId } : {}),
      ...(title ? { title } : {}),
      ...(terms.length > 0
        ? { terms }
        : title
          ? { terms: [{ value: title }] }
          : {}),
    });
  }

  if (parsed.length > 0) return parsed;

  const terms = parseTerms(fallbackTerms);
  return terms.length > 0 ? [{ terms }] : [];
}

function parsePageAction(value: unknown) {
  return value === "next" || value === "restart" || value === "first"
    ? value
    : undefined;
}

function parsePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function constrainPlanToCapabilities(
  plan: RetrievalPlan,
  capabilities: SourceCapabilities,
): RetrievalPlan {
  if (plan.kind === "mixed") {
    const plans = plan.plans
      .map((child) => constrainPlanToCapabilities(child, capabilities))
      .filter((child) => child.kind !== "none");
    return plans.length > 0 ? { ...plan, plans } : fallbackPlan(capabilities);
  }

  if (plan.kind.startsWith("catalog_") && !capabilities.catalog.available) {
    return capabilities.documents.available
      ? {
          kind: "document_retrieval",
          reason: "Catalog is unavailable for this source scope",
        }
      : {
          kind: "none",
          reason: "No catalog or document source is available",
        };
  }

  if (plan.kind === "document_retrieval" && !capabilities.documents.available) {
    return capabilities.catalog.available
      ? { kind: "catalog_overview", reason: "Documents are unavailable" }
      : { kind: "none", reason: "No source is available" };
  }

  return plan;
}

function addRawUserValidationCandidates(
  plan: RetrievalPlan,
  userMessage: string,
): RetrievalPlan {
  if (plan.kind === "mixed") {
    return {
      ...plan,
      plans: plan.plans.map((child) =>
        addRawUserValidationCandidates(child, userMessage),
      ),
    };
  }

  if (plan.kind === "catalog_detail") {
    return {
      ...plan,
      products: plan.products.map((product) => ({
        ...product,
        terms: addRawCandidatesToTerms(product.terms ?? [], userMessage),
      })),
    };
  }

  if (plan.kind !== "catalog_search" && plan.kind !== "catalog_count") {
    return plan;
  }

  return {
    ...plan,
    terms: addRawCandidatesToTerms(plan.terms, userMessage),
  };
}

function addRawCandidatesToTerms(
  terms: CatalogSearchTerm[],
  userMessage: string,
): CatalogSearchTerm[] {
  if (terms.length !== 1) return terms;

  const rawCandidates = extractRawIdentifierCandidates(userMessage).filter(
    (candidate) =>
      normalizeCatalogValue(candidate.value) !==
      normalizeCatalogValue(terms[0]?.value ?? ""),
  );
  if (rawCandidates.length === 0) return terms;

  return [
    {
      ...terms[0],
      validationCandidates: [
        ...(terms[0].validationCandidates ?? []),
        ...rawCandidates,
      ],
    },
  ];
}

function extractRawIdentifierCandidates(message: string): CatalogSearchTerm[] {
  const candidates: CatalogSearchTerm[] = [];
  const seen = new Set<string>();

  for (const match of message.matchAll(/[A-Za-z][A-Za-z0-9_-]{1,}/gu)) {
    const value = match[0]?.trim();
    if (!value) continue;
    const normalized = normalizeCatalogValue(value);
    if (!normalized || GENERIC_CATALOG_TERM_TOKENS.has(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    candidates.push({ value });
  }

  return candidates.slice(0, 4);
}

function normalizeGenericCatalogTerms(
  plan: RetrievalPlan,
  userMessage: string,
  capabilities: SourceCapabilities,
  previousCatalogFocus?: RetrievalCatalogFocus,
): RetrievalPlan {
  if (plan.kind === "mixed") {
    return {
      ...plan,
      plans: plan.plans.map((child) =>
        normalizeGenericCatalogTerms(
          child,
          userMessage,
          capabilities,
          previousCatalogFocus,
        ),
      ),
    };
  }

  const scopeAliases = getCatalogScopeAliases(capabilities);
  const termScopeSourceIds = matchCatalogScopeSourcesForTerms(
    plan.kind === "catalog_search" || plan.kind === "catalog_count"
      ? plan.terms
      : [],
    scopeAliases,
  );
  const mentionedScopeSourceIds = matchCatalogScopeSourcesForText(
    userMessage,
    scopeAliases,
  );
  const scopeSourceIds =
    termScopeSourceIds.length > 0
      ? termScopeSourceIds
      : mentionedScopeSourceIds;
  const previousScopeSourceIds = normalizeSourceIds(
    previousCatalogFocus?.scopeSourceIds,
  );

  if (
    plan.kind === "catalog_search" &&
    (termScopeSourceIds.length > 0 ||
      (plan.terms.length === 0 && mentionedScopeSourceIds.length > 0))
  ) {
    return {
      ...plan,
      terms: [],
      allProducts: true,
      scopeSourceIds,
      reason:
        "A configured catalog scope alias means the whole catalog, so list products from the matching catalog scope",
    };
  }

  if (
    plan.kind === "catalog_count" &&
    (termScopeSourceIds.length > 0 ||
      (plan.terms.length === 0 && mentionedScopeSourceIds.length > 0))
  ) {
    return {
      ...plan,
      terms: [],
      scopeSourceIds,
      reason:
        "A configured catalog scope alias means the whole catalog, so count active products in the matching catalog scope",
    };
  }

  if (
    plan.kind === "catalog_search" &&
    plan.terms.length === 0 &&
    previousScopeSourceIds.length > 0
  ) {
    return {
      ...plan,
      terms: [],
      allProducts: true,
      scopeSourceIds: previousScopeSourceIds,
      reason:
        "Empty-term catalog list follow-up keeps the previous catalog scope",
    };
  }

  if (plan.kind === "catalog_search" && containsOnlyGenericCatalogTerms(plan)) {
    return {
      kind: "catalog_overview",
      reason:
        "Catalog search only contained generic inventory words, so overview is safer",
    };
  }

  if (plan.kind === "catalog_count" && containsOnlyGenericCatalogTerms(plan)) {
    return {
      ...plan,
      terms: [],
      reason:
        "Catalog count only contained generic inventory words, so count all active products",
    };
  }

  return plan;
}

function containsOnlyGenericCatalogTerms(plan: { terms: CatalogSearchTerm[] }) {
  return (
    plan.terms.length > 0 &&
    plan.terms.every((term) => isGenericCatalogTerm(term.value))
  );
}

type CatalogScopeAlias = {
  value: string;
  sourceId: string;
};

function matchCatalogScopeSourcesForTerms(
  terms: CatalogSearchTerm[],
  aliases: CatalogScopeAlias[],
) {
  if (terms.length === 0 || aliases.length === 0) return [];
  const sourceIds = new Set<string>();

  for (const term of terms) {
    const normalized = normalizeCatalogValue(term.value);
    const matches = aliases.filter(
      (alias) => normalizeCatalogValue(alias.value) === normalized,
    );
    if (matches.length === 0) return [];
    for (const match of matches) sourceIds.add(match.sourceId);
  }

  return [...sourceIds];
}

function matchCatalogScopeSourcesForText(
  value: string,
  aliases: CatalogScopeAlias[],
) {
  const tokens = tokenizeCatalogText(value);
  const sourceIds = new Set<string>();
  for (const alias of aliases) {
    if (containsTokenSequence(tokens, tokenizeCatalogText(alias.value))) {
      sourceIds.add(alias.sourceId);
    }
  }
  return [...sourceIds];
}

function getCatalogScopeAliases(
  capabilities: SourceCapabilities,
): CatalogScopeAlias[] {
  const seen = new Set<string>();
  const aliases: CatalogScopeAlias[] = [];
  for (const scope of capabilities.catalog.scopes) {
    for (const value of [scope.name, ...scope.aliases]) {
      const alias = String(value ?? "").trim();
      const normalized = normalizeCatalogValue(alias);
      const key = `${scope.sourceId}:${normalized}`;
      if (!normalized || seen.has(key)) continue;
      seen.add(key);
      aliases.push({ value: alias, sourceId: scope.sourceId });
    }
  }
  return aliases;
}

function normalizeSourceIds(values: string[] | undefined) {
  if (!values) return [];
  const seen = new Set<string>();
  const sourceIds: string[] = [];
  for (const value of values) {
    const sourceId = String(value ?? "").trim();
    if (!sourceId || seen.has(sourceId)) continue;
    seen.add(sourceId);
    sourceIds.push(sourceId);
  }
  return sourceIds;
}

function tokenizeCatalogText(value: string) {
  return normalizeCatalogValue(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function containsTokenSequence(tokens: string[], sequence: string[]) {
  if (sequence.length === 0 || sequence.length > tokens.length) return false;
  for (let index = 0; index <= tokens.length - sequence.length; index += 1) {
    if (sequence.every((token, offset) => tokens[index + offset] === token)) {
      return true;
    }
  }
  return false;
}

const GENERIC_CATALOG_TERM_TOKENS = new Set([
  "a",
  "all",
  "any",
  "available",
  "catalog",
  "catalogue",
  "carry",
  "do",
  "does",
  "have",
  "inventory",
  "item",
  "items",
  "list",
  "me",
  "product",
  "products",
  "sell",
  "show",
  "stock",
  "the",
  "what",
  "which",
  "you",
  "your",
  "αποθεμα",
  "διαθετετε",
  "διαθετεισ",
  "ειδη",
  "εχετε",
  "εχεισ",
  "καταλογο",
  "καταλογοσ",
  "μου",
  "ποια",
  "ποιο",
  "ποιοι",
  "ποιουσ",
  "προιον",
  "προιοντα",
  "τι",
  "υπαρχουν",
]);

function isGenericCatalogTerm(value: string) {
  const normalized = normalizeCatalogValue(value);
  const tokens = normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

  return (
    tokens.length > 0 &&
    tokens.every((token) => GENERIC_CATALOG_TERM_TOKENS.has(token))
  );
}

function fallbackPlan(capabilities: SourceCapabilities): RetrievalPlan {
  if (capabilities.catalog.available && capabilities.documents.available) {
    return {
      kind: "mixed",
      reason:
        "Planner fallback uses conservative catalog capability context and ordinary document retrieval",
      plans: [
        {
          kind: "catalog_capabilities",
          reason:
            "Catalog capabilities provide safety context when planner output is unavailable",
        },
        {
          kind: "document_retrieval",
          reason: "Ordinary document retrieval remains available",
        },
      ],
    };
  }
  if (capabilities.documents.available) {
    return {
      kind: "document_retrieval",
      reason: "Planner fallback uses ordinary document retrieval",
    };
  }
  if (capabilities.catalog.available) {
    return {
      kind: "catalog_overview",
      reason: "Planner fallback uses catalog overview",
    };
  }
  return { kind: "none", reason: "No retrieval source is available" };
}

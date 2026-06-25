import type {
  CatalogListContinuationState,
  CatalogStructuredFilter,
  CatalogStructuredIntent,
  CatalogStructuredLookupIntent,
} from "./query";

export function shouldUseCatalogStructuredLane(
  activeCatalogProductCount: number,
  hasCatalogLane: boolean,
): boolean {
  return hasCatalogLane && activeCatalogProductCount > 0;
}

export function detectCatalogContinuationReply(query: string): boolean {
  const normalized = normalizeRoutingText(query);
  if (!normalized || normalized.length > 48) return false;

  return (
    CONTINUATION_REPLIES.has(normalized) ||
    matchesAny(normalized, [
      /^show more$/u,
      /^next page$/u,
      /^go on$/u,
      /^keep going$/u,
      /^continue$/u,
      /^more please$/u,
      /^δειξε (μου )?(κι |και )?αλλα$/u,
      /^τα επομενα$/u,
    ])
  );
}

export function resolveCatalogStructuredLookup(
  intent: CatalogStructuredIntent | "none",
  filters: CatalogStructuredFilter[],
  previousCatalogPage: CatalogListContinuationState | undefined,
  defaultLimit: number,
): {
  intent: CatalogStructuredLookupIntent;
  filters: CatalogStructuredFilter[];
  offset: number;
  limit: number;
} | null {
  if (intent === "none") return null;

  if (intent === "continue_list") {
    if (!previousCatalogPage) return null;
    return {
      intent: previousCatalogPage.intent,
      filters: previousCatalogPage.filters,
      offset: previousCatalogPage.nextOffset,
      limit: previousCatalogPage.limit || defaultLimit,
    };
  }

  if (intent === "filter" && filters.length === 0) return null;

  return {
    intent,
    filters: intent === "filter" || intent === "count" ? filters : [],
    offset: 0,
    limit: defaultLimit,
  };
}

export function detectCatalogCapabilitiesQuestion(query: string): boolean {
  const normalized = normalizeRoutingText(query);
  if (!normalized) return false;

  const hasFilterMechanismTerm = matchesAny(normalized, [
    /\bfilters?\b/u,
    /\bfields?\b/u,
    /\bfacets?\b/u,
    /\bnarrow\b/u,
    /\bsearch options?\b/u,
    /φιλτρ/u,
    /πεδι/u,
  ]);
  const hasValueTypeTerm = matchesAny(normalized, [
    /\bbrands?\b/u,
    /\bcategories?\b/u,
    /\btypes?\b/u,
    /\boptions?\b/u,
    /\bfamil(?:y|ies)\b/u,
    /μαρκ/u,
    /κατηγορι/u,
    /τυπ/u,
    /επιλογ/u,
  ]);
  const hasQuestionTerm = matchesAny(normalized, [
    /\bwhat\b/u,
    /\bwhich\b/u,
    /\bhow\b/u,
    /\bcan\b/u,
    /\buse\b/u,
    /(?:^|\s)τι(?:\s|$)/u,
    /(?:^|\s)ποια(?:\s|$)/u,
    /(?:^|\s)ποιες(?:\s|$)/u,
    /μπορ/u,
    /χρησιμοποι/u,
  ]);
  const hasAvailabilityTerm = matchesAny(normalized, [
    /\bavailable\b/u,
    /\bhave\b/u,
    /\bhas\b/u,
    /\bexist\b/u,
    /\bthere\b/u,
    /\bcarry\b/u,
    /\boffer\b/u,
    /διαθεσιμ/u,
    /διαθετ/u,
    /εχετ/u,
    /υπαρχ/u,
    /προσφερ/u,
  ]);

  if (hasFilterMechanismTerm && (hasQuestionTerm || hasAvailabilityTerm)) {
    return true;
  }

  return hasValueTypeTerm && hasAvailabilityTerm;
}

export function detectCatalogCountQuestion(query: string): boolean {
  const normalized = normalizeRoutingText(query);
  if (!normalized) return false;

  const hasCountTerm = matchesAny(normalized, [
    /\bhow many\b/u,
    /\bcount\b/u,
    /\bnumber of\b/u,
    /\btotal\b/u,
    /(?:^|\s)ποσα(?:\s|$)/u,
    /(?:^|\s)ποσεσ(?:\s|$)/u,
    /(?:^|\s)ποσοι(?:\s|$)/u,
    /αριθμ/u,
    /συνολ/u,
  ]);
  const hasInventoryTerm = matchesAny(normalized, [
    /\bproducts?\b/u,
    /\bitems?\b/u,
    /\bskus?\b/u,
    /\bcatalog\b/u,
    /\bavailable\b/u,
    /\bexist\b/u,
    /\bthere\b/u,
    /προιον/u,
    /ειδ/u,
    /κωδικ/u,
    /καταλογ/u,
    /διαθεσιμ/u,
    /υπαρχ/u,
  ]);

  return hasCountTerm && hasInventoryTerm;
}

export function detectCatalogNonInventoryQuestion(query: string): boolean {
  const normalized = normalizeRoutingText(query);
  if (!normalized) return false;

  return matchesAny(normalized, [
    /\bingredients?\b/u,
    /\bwarnings?\b/u,
    /\bprecautions?\b/u,
    /\busage\b/u,
    /\binstructions?\b/u,
    /\bprice\b/u,
    /\bcost\b/u,
    /\bdimensions?\b/u,
    /\bpackage size\b/u,
    /\bnutrition\b/u,
    /\bbarcode\b/u,
    /\bgtin\b/u,
    /\bcompare\b/u,
    /\brecommend/u,
    /συστατικ/u,
    /προειδοποι/u,
    /προφυλαξ/u,
    /χρηση/u,
    /οδηγι/u,
    /τιμη/u,
    /κοστιζ/u,
    /διαστασ/u,
    /μεγεθοσ/u,
    /συσκευασ/u,
    /barcode/u,
    /gtin/u,
    /συγκριν/u,
    /προτειν/u,
  ]);
}

export function repairCatalogFilterTermsFromQuery(
  filters: CatalogStructuredFilter[],
  query: string,
): CatalogStructuredFilter[] {
  if (filters.length === 0) return filters;

  const normalizedQuery = normalizeRoutingText(query);
  const originalCandidate = extractOriginalScriptFilterCandidate(query);
  if (!originalCandidate) return filters;

  return filters.map((filter) => {
    const normalizedFilter = normalizeRoutingText(filter.value);
    if (!normalizedFilter || normalizedQuery.includes(normalizedFilter)) {
      return filter;
    }

    return {
      ...filter,
      value: originalCandidate,
    };
  });
}

export function inferCatalogFiltersFromInventoryQuestion(
  query: string,
): CatalogStructuredFilter[] {
  if (!detectCatalogInventoryQuestion(query)) return [];

  const originalCandidate = extractOriginalScriptFilterCandidate(query);
  return originalCandidate ? [{ value: originalCandidate }] : [];
}

export function detectCatalogOverviewQuestion(query: string): boolean {
  const normalized = normalizeRoutingText(query);
  if (!normalized) return false;

  const hasInventoryTerm = matchesAny(normalized, [
    /\bproducts?\b/u,
    /\bitems?\b/u,
    /\bskus?\b/u,
    /\bcatalog\b/u,
    /προιον/u,
    /ειδ/u,
    /κωδικ/u,
    /καταλογ/u,
  ]);
  const hasAvailabilityQuestion = matchesAny(normalized, [
    /\bwhat\b/u,
    /\bwhich\b/u,
    /\bhave\b/u,
    /\bhas\b/u,
    /\bcarry\b/u,
    /\boffer\b/u,
    /(?:^|\s)τι(?:\s|$)/u,
    /εχετ/u,
    /εχει/u,
    /υπαρχ/u,
    /διαθετ/u,
  ]);
  const hasExplicitListCommand = matchesAny(normalized, [
    /\bshow\b/u,
    /\blist\b/u,
    /\bdisplay\b/u,
    /^δειξε/u,
    /(?:^|\s)λιστα(?:\s|$)/u,
  ]);

  return (
    hasInventoryTerm &&
    hasAvailabilityQuestion &&
    !hasExplicitListCommand &&
    extractOriginalScriptFilterCandidate(query) === null
  );
}

export function detectCatalogInventoryQuestion(query: string): boolean {
  const normalized = normalizeRoutingText(query);
  if (!normalized) return false;

  const hasInventoryTerm = matchesAny(normalized, [
    /\bproducts?\b/u,
    /\bitems?\b/u,
    /\bskus?\b/u,
    /\bcatalog\b/u,
    /προιον/u,
    /ειδ/u,
    /κωδικ/u,
    /καταλογ/u,
  ]);
  const hasRequestTerm = matchesAny(normalized, [
    /\bshow\b/u,
    /\blist\b/u,
    /\bhave\b/u,
    /\bhas\b/u,
    /\bwhich\b/u,
    /\bwhat\b/u,
    /\boffer\b/u,
    /\bcarry\b/u,
    /δειξε/u,
    /εχετ/u,
    /εχει/u,
    /ποια/u,
    /ποιεσ/u,
  ]);

  return (
    hasRequestTerm &&
    (hasInventoryTerm || extractOriginalScriptFilterCandidate(query) !== null)
  );
}

export function sanitizeCatalogStructuredFilters(
  filters: CatalogStructuredFilter[],
): CatalogStructuredFilter[] {
  return filters.filter((filter) => !isGenericFilterTerm(filter.value));
}

function isGenericFilterTerm(value: string): boolean {
  const normalized = normalizeRoutingText(value);
  if (!normalized) return true;
  if (GENERIC_FILTER_WORDS.has(normalized)) return true;

  const tokens = normalized.split(" ").filter(Boolean);
  return (
    tokens.length > 0 &&
    tokens.every((token) => GENERIC_FILTER_WORDS.has(token))
  );
}

function extractOriginalScriptFilterCandidate(query: string): string | null {
  const tokens = query
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .filter((token) => !GENERIC_FILTER_WORDS.has(normalizeRoutingText(token)));

  if (tokens.length === 0 || tokens.length > 6) return null;
  return tokens.join(" ");
}

const GENERIC_FILTER_WORDS = new Set([
  "show",
  "list",
  "products",
  "product",
  "items",
  "item",
  "catalog",
  "have",
  "has",
  "which",
  "what",
  "how",
  "many",
  "there",
  "available",
  "filters",
  "filter",
  "fields",
  "field",
  "use",
  "brands",
  "brand",
  "categories",
  "category",
  "me",
  "please",
  "is",
  "are",
  "τι",
  "ποια",
  "ποιεσ",
  "ποιο",
  "ποιοι",
  "μου",
  "μασ",
  "εχετε",
  "εχεισ",
  "εχει",
  "εχουμε",
  "ειναι",
  "υπαρχουν",
  "διαθεσιμα",
  "διαθεσιμεσ",
  "προιοντα",
  "προιον",
  "προιοντων",
  "ειδη",
  "κωδικοι",
  "καταλογοσ",
  "καταλογο",
  "δειξε",
  "λιστα",
  "φιλτρα",
  "φιλτρο",
  "πεδια",
  "μαρκεσ",
  "μαρκα",
  "κατηγοριεσ",
  "κατηγορια",
  "στη",
  "στην",
  "στο",
  "στον",
  "στα",
  "στισ",
  "σε",
  "με",
  "για",
]);

const CONTINUATION_REPLIES = new Set([
  "yes",
  "y",
  "yeah",
  "yep",
  "sure",
  "ok",
  "okay",
  "more",
  "next",
  "continue",
  "ναι",
  "συνεχισε",
  "επομενα",
  "επομενο",
  "περισσοτερα",
  "αλλα",
  "κι αλλα",
  "και αλλα",
]);

function normalizeRoutingText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/ς/g, "σ")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

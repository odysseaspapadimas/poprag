import { and, asc, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  catalogConfig,
  catalogProduct,
  catalogProductFact,
  knowledgeSource,
} from "@/db/schema";
import {
  getCatalogSearchableQueryCandidates,
  getPathValue,
  normalizeCatalogFactValue,
  normalizeCatalogValue,
  stringifyScalar,
  uniqueFieldList,
} from "@/lib/catalog/shared";
import {
  buildActiveCatalogProductWhere,
  countActiveCatalogProducts,
} from "./source-capability-index";
import type {
  CatalogEvidence,
  CatalogEvidenceDiagnostics,
  CatalogPageAction,
  CatalogProductEvidence,
  CatalogProductFocusItem,
  CatalogProductReference,
  CatalogProductResolutionDiagnostics,
  CatalogSearchMode,
  CatalogSearchTerm,
  CatalogSearchTermCandidate,
  RetrievalPageCursor,
  RetrievalPlan,
  SourceCapabilities,
} from "./types";

type CatalogProductRow = {
  productId: string;
  sourceId: string;
  recordKey: string;
  title: string | null;
  data: Record<string, unknown> | null;
  stableKeyField: string;
  titleField: string;
  exactMatchFields: string[] | null;
  filterableFields: string[] | null;
  searchableFields: string[] | null;
};

type CandidateFactRow = {
  productId: string;
  role: "stable_key" | "title" | "exact" | "searchable" | "filterable";
  fieldPath: string;
  normalizedValue: string;
};

type ProductReferenceResolution = {
  requested: CatalogProductReference;
  status: CatalogProductResolutionDiagnostics["status"];
  selectedProductIds: string[];
  rejectedProductIds: string[];
  candidateRows: CatalogProductRow[];
};

const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 50;
const MAX_DETAIL_PRODUCTS = 8;
const PRODUCT_ID_CHUNK_SIZE = 80;
const CATALOG_QUERY_STOP_TOKENS = new Set([
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

export async function executeCatalogPlan(options: {
  plan: RetrievalPlan;
  capabilities: SourceCapabilities;
  previousCatalogPage?: RetrievalPageCursor;
  defaultLimit?: number;
}): Promise<{
  evidence?: CatalogEvidence;
  diagnostics: CatalogEvidenceDiagnostics;
}> {
  const catalogPlan = selectCatalogPlan(options.plan);
  if (!catalogPlan) {
    return {
      diagnostics: {
        attempted: false,
        validationResult: "skipped",
      },
    };
  }

  if (!options.capabilities.catalog.available) {
    return {
      evidence: {
        kind: "no_match",
        terms: [],
        totalActiveProducts: 0,
        code: "catalog_unavailable",
        message: "No active catalog is available for this source scope.",
      },
      diagnostics: {
        attempted: true,
        evidenceKind: "no_match",
        validationResult: "skipped",
        errorCode: "catalog_unavailable",
      },
    };
  }

  if (catalogPlan.kind === "catalog_overview") {
    const evidence: CatalogEvidence = {
      kind: "overview",
      totalActiveProducts: options.capabilities.catalog.activeProductCount,
      filterValueSummaries: options.capabilities.catalog.filterValueSummaries,
      fieldCapabilities: options.capabilities.catalog.fieldCapabilities,
    };
    return {
      evidence,
      diagnostics: {
        attempted: true,
        evidenceKind: evidence.kind,
        validationResult: "validated",
        matchedProducts: evidence.totalActiveProducts,
        returnedProducts: 0,
      },
    };
  }

  if (catalogPlan.kind === "catalog_capabilities") {
    const evidence: CatalogEvidence = {
      kind: "capabilities",
      totalActiveProducts: options.capabilities.catalog.activeProductCount,
      filterValueSummaries: options.capabilities.catalog.filterValueSummaries,
      fieldCapabilities: options.capabilities.catalog.fieldCapabilities,
      requestedField: catalogPlan.requestedField,
    };
    return {
      evidence,
      diagnostics: {
        attempted: true,
        evidenceKind: evidence.kind,
        validationResult: "validated",
        matchedProducts: evidence.totalActiveProducts,
        returnedProducts: 0,
      },
    };
  }

  if (catalogPlan.kind === "catalog_continue") {
    if (!options.previousCatalogPage?.hasMore) {
      return noMatch({
        terms: [],
        totalActiveProducts: options.capabilities.catalog.activeProductCount,
        code: "continuation_unavailable",
        message: "There is no catalog page to continue.",
      });
    }

    return executeSearchOrCount({
      capabilities: options.capabilities,
      terms: options.previousCatalogPage.terms,
      offset: options.previousCatalogPage.nextOffset,
      limit: options.previousCatalogPage.limit,
      countOnly: false,
      searchMode: "inventory",
      pageAction: "next",
      allProducts: options.previousCatalogPage.terms.length === 0,
      scopeSourceIds: options.previousCatalogPage.scopeSourceIds,
    });
  }

  if (catalogPlan.kind === "catalog_count") {
    return executeSearchOrCount({
      capabilities: options.capabilities,
      terms: catalogPlan.terms,
      offset: 0,
      limit: 0,
      countOnly: true,
      searchMode: "inventory",
      pageAction: "first",
      scopeSourceIds: catalogPlan.scopeSourceIds,
    });
  }

  if (catalogPlan.kind === "catalog_search") {
    const pageAction = catalogPlan.pageAction ?? "first";
    if (pageAction === "next" && options.previousCatalogPage?.hasMore) {
      return executeSearchOrCount({
        capabilities: options.capabilities,
        terms: options.previousCatalogPage.terms,
        offset: options.previousCatalogPage.nextOffset,
        limit: options.previousCatalogPage.limit,
        countOnly: false,
        searchMode: "inventory",
        pageAction,
        allProducts: options.previousCatalogPage.terms.length === 0,
        scopeSourceIds: options.previousCatalogPage.scopeSourceIds,
      });
    }

    return executeSearchOrCount({
      capabilities: options.capabilities,
      terms: catalogPlan.terms,
      offset: 0,
      limit: normalizeLimit(catalogPlan.limit ?? options.defaultLimit),
      countOnly: false,
      searchMode: "inventory",
      pageAction,
      allProducts: catalogPlan.allProducts === true,
      scopeSourceIds: catalogPlan.scopeSourceIds,
    });
  }

  if (catalogPlan.kind === "catalog_detail") {
    return executeProductDetail({
      capabilities: options.capabilities,
      products: catalogPlan.products,
    });
  }

  return {
    diagnostics: {
      attempted: true,
      validationResult: "invalid_plan",
      errorCode: "unsupported_plan",
    },
  };
}

async function executeSearchOrCount(options: {
  capabilities: SourceCapabilities;
  terms: CatalogSearchTerm[];
  offset: number;
  limit: number;
  countOnly: boolean;
  searchMode: CatalogSearchMode;
  pageAction: CatalogPageAction;
  allProducts?: boolean;
  scopeSourceIds?: string[];
}): Promise<{
  evidence?: CatalogEvidence;
  diagnostics: CatalogEvidenceDiagnostics;
}> {
  const terms = normalizeTerms(options.terms);
  const hasScopeFilter =
    options.scopeSourceIds !== undefined && options.scopeSourceIds.length > 0;
  const scopedKnowledgeSourceIds = mergeKnowledgeSourceIds(
    options.capabilities.knowledgeSourceIds,
    options.scopeSourceIds,
  );
  const scopeSourceIds = hasScopeFilter ? scopedKnowledgeSourceIds : undefined;
  const totalActiveProducts = hasScopeFilter
    ? (scopedKnowledgeSourceIds?.length ?? 0) > 0
      ? await countActiveCatalogProducts({
          agentId: options.capabilities.agentId,
          knowledgeSourceIds: scopedKnowledgeSourceIds,
        })
      : 0
    : options.capabilities.catalog.activeProductCount;
  const scopeLabel = scopeSourceIds
    ? formatScopeLabel(options.capabilities, scopeSourceIds)
    : undefined;

  if (terms.length === 0 && !options.countOnly && !options.allProducts) {
    return noMatch({
      terms,
      totalActiveProducts,
      code: "empty_terms",
      message: "The planner did not provide catalog search terms to validate.",
    });
  }

  const productIds =
    terms.length > 0
      ? await findValidatedProductIds({
          agentId: options.capabilities.agentId,
          knowledgeSourceIds: scopedKnowledgeSourceIds,
          terms,
          mode: options.searchMode,
        })
      : undefined;

  if (terms.length > 0 && productIds?.productIds.length === 0) {
    return noMatch({
      terms,
      totalActiveProducts,
      code: "no_match",
      message: "No active catalog products matched the validated terms.",
    });
  }

  const resolvedTerms = productIds?.terms ?? terms;
  const matchedProducts = productIds?.productIds.length ?? totalActiveProducts;

  if (options.countOnly) {
    const evidence: CatalogEvidence = {
      kind: "count",
      terms: resolvedTerms,
      scopeSourceIds,
      scopeLabel,
      totalActiveProducts,
      matchedProducts,
    };
    return {
      evidence,
      diagnostics: {
        attempted: true,
        evidenceKind: evidence.kind,
        validationResult: "validated",
        matchedProducts,
        returnedProducts: 0,
        searchMode: options.searchMode,
        pageAction: options.pageAction,
      },
    };
  }

  const limit = normalizeLimit(options.limit);
  const offset = Math.max(0, options.offset);
  const products =
    matchedProducts > 0
      ? await listActiveCatalogProducts({
          agentId: options.capabilities.agentId,
          knowledgeSourceIds: scopedKnowledgeSourceIds,
          productIds: productIds?.productIds,
          limit,
          offset,
        })
      : [];
  const nextOffset = offset + products.length;
  const hasMore = nextOffset < matchedProducts;
  const evidence: CatalogEvidence = {
    kind: "product_page",
    terms: resolvedTerms,
    scopeSourceIds,
    scopeLabel,
    totalActiveProducts,
    matchedProducts,
    products: products.map((product) => formatProductEvidence(product)),
    offset,
    limit,
    nextOffset,
    hasMore,
    complete: !hasMore,
  };

  return {
    evidence,
    diagnostics: {
      attempted: true,
      evidenceKind: evidence.kind,
      validationResult: "validated",
      matchedProducts,
      returnedProducts: evidence.products.length,
      offset,
      limit,
      nextOffset,
      hasMore,
      searchMode: options.searchMode,
      pageAction: options.pageAction,
    },
  };
}

async function executeProductDetail(options: {
  capabilities: SourceCapabilities;
  products: CatalogProductReference[];
}): Promise<{
  evidence?: CatalogEvidence;
  diagnostics: CatalogEvidenceDiagnostics;
}> {
  const totalActiveProducts = options.capabilities.catalog.activeProductCount;
  const productRefs = normalizeProductReferences(options.products);

  if (productRefs.length === 0) {
    return noMatch({
      terms: [],
      totalActiveProducts,
      code: "empty_terms",
      message: "The planner did not provide products to validate.",
    });
  }

  const resolutions = await Promise.all(
    productRefs.map((product) =>
      resolveProductReference({ capabilities: options.capabilities, product }),
    ),
  );
  const resolutionDiagnostics = resolutions.map(formatProductResolution);
  const ambiguous = resolutions.filter(
    (resolution) => resolution.status === "ambiguous",
  );

  if (ambiguous.length > 0) {
    const references = ambiguous.map((resolution) => ({
      requested: resolution.requested,
      candidates: resolution.candidateRows.map((row) =>
        formatProductEvidence(row, { includeSearchableFields: false }),
      ),
    }));
    const candidateCount = references.reduce(
      (sum, reference) => sum + reference.candidates.length,
      0,
    );
    const evidence: CatalogEvidence = {
      kind: "product_clarification",
      totalActiveProducts,
      references,
      message:
        "Multiple catalog products matched at least one requested product.",
    };

    return {
      evidence,
      diagnostics: {
        attempted: true,
        evidenceKind: evidence.kind,
        validationResult: "needs_clarification",
        errorCode: "ambiguous_product",
        matchedProducts: candidateCount,
        returnedProducts: candidateCount,
        searchMode: "detail",
        productResolutions: resolutionDiagnostics,
      },
    };
  }

  const productIds = uniqueInOrder(
    resolutions.flatMap((resolution) => resolution.selectedProductIds),
  ).slice(0, MAX_DETAIL_PRODUCTS);

  if (productIds.length === 0) {
    const result = noMatch({
      terms: productRefs.flatMap((product) => product.terms ?? []),
      totalActiveProducts,
      code: "no_match",
      message: "No active catalog products matched the validated products.",
    });
    result.diagnostics.searchMode = "detail";
    result.diagnostics.productResolutions = resolutionDiagnostics;
    return result;
  }

  const rows = await listActiveCatalogProductsByIds({
    agentId: options.capabilities.agentId,
    knowledgeSourceIds: options.capabilities.knowledgeSourceIds,
    productIds,
  });
  if (rows.length === 0) {
    const result = noMatch({
      terms: productRefs.flatMap((product) => product.terms ?? []),
      totalActiveProducts,
      code: "no_match",
      message: "No active catalog products matched the validated products.",
    });
    result.diagnostics.searchMode = "detail";
    result.diagnostics.productResolutions = resolutionDiagnostics;
    return result;
  }

  const evidence: CatalogEvidence = {
    kind: "product_detail",
    totalActiveProducts,
    matchedProducts: rows.length,
    products: rows.map((row) =>
      formatProductEvidence(row, { includeSearchableFields: true }),
    ),
  };

  return {
    evidence,
    diagnostics: {
      attempted: true,
      evidenceKind: evidence.kind,
      validationResult: "validated",
      matchedProducts: rows.length,
      returnedProducts: evidence.products.length,
      searchMode: "detail",
      productResolutions: resolutionDiagnostics,
    },
  };
}

async function resolveProductReference(options: {
  capabilities: SourceCapabilities;
  product: CatalogProductReference;
}): Promise<ProductReferenceResolution> {
  const terms = termsForProductReference(options.product);
  const candidateIds =
    terms.length > 0
      ? (
          await findValidatedProductIds({
            agentId: options.capabilities.agentId,
            knowledgeSourceIds: options.capabilities.knowledgeSourceIds,
            terms,
            mode: "detail",
          })
        ).productIds.slice(0, MAX_DETAIL_PRODUCTS)
      : [];
  const candidateRows = await listActiveCatalogProductsByIds({
    agentId: options.capabilities.agentId,
    knowledgeSourceIds: options.capabilities.knowledgeSourceIds,
    productIds: candidateIds,
  });

  const productId = options.product.productId?.trim();
  const hasValidationText = terms.length > 0 || !!options.product.title;

  if (productId && !hasValidationText) {
    const row = await listActiveCatalogProductsByIds({
      agentId: options.capabilities.agentId,
      knowledgeSourceIds: options.capabilities.knowledgeSourceIds,
      productIds: [productId],
    });
    return {
      requested: options.product,
      status: row.length > 0 ? "product_id_unqualified" : "no_match",
      selectedProductIds: row.length > 0 ? [productId] : [],
      rejectedProductIds: [],
      candidateRows: row,
    };
  }

  if (productId && candidateRows.length > 0) {
    const candidateIdSet = new Set(candidateRows.map((row) => row.productId));
    if (!candidateIdSet.has(productId)) {
      return resolutionFromCandidates({
        requested: options.product,
        candidateRows,
        rejectedProductIds: [productId],
      });
    }
  }

  return resolutionFromCandidates({
    requested: options.product,
    candidateRows,
    rejectedProductIds: [],
  });
}

function resolutionFromCandidates(options: {
  requested: CatalogProductReference;
  candidateRows: CatalogProductRow[];
  rejectedProductIds: string[];
}): ProductReferenceResolution {
  if (options.candidateRows.length === 0) {
    return {
      requested: options.requested,
      status:
        options.rejectedProductIds.length > 0
          ? "product_id_rejected"
          : "no_match",
      selectedProductIds: [],
      rejectedProductIds: options.rejectedProductIds,
      candidateRows: [],
    };
  }

  if (options.candidateRows.length > 1) {
    return {
      requested: options.requested,
      status: "ambiguous",
      selectedProductIds: [],
      rejectedProductIds: options.rejectedProductIds,
      candidateRows: options.candidateRows,
    };
  }

  return {
    requested: options.requested,
    status:
      options.rejectedProductIds.length > 0
        ? "product_id_rejected"
        : "selected",
    selectedProductIds: [options.candidateRows[0]!.productId],
    rejectedProductIds: options.rejectedProductIds,
    candidateRows: options.candidateRows,
  };
}

function termsForProductReference(
  product: CatalogProductReference,
): CatalogSearchTerm[] {
  const terms = normalizeTerms(product.terms ?? []);
  if (terms.length > 0) return terms;
  if (product.title?.trim()) return [{ value: product.title.trim() }];
  return [];
}

function formatProductResolution(
  resolution: ProductReferenceResolution,
): CatalogProductResolutionDiagnostics {
  return {
    requested: resolution.requested,
    status: resolution.status,
    selectedProductIds: resolution.selectedProductIds,
    rejectedProductIds: resolution.rejectedProductIds,
    candidates: resolution.candidateRows.map(formatProductFocusItem),
  };
}

function formatProductFocusItem(
  row: CatalogProductRow,
): CatalogProductFocusItem {
  return {
    productId: row.productId,
    title: row.title || row.recordKey,
    recordKey: row.recordKey,
  };
}

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

async function listActiveCatalogProductsByIds(options: {
  agentId: string;
  knowledgeSourceIds?: string[];
  productIds: string[];
}): Promise<CatalogProductRow[]> {
  if (options.productIds.length === 0) return [];

  const rows = await listActiveCatalogProducts({
    agentId: options.agentId,
    knowledgeSourceIds: options.knowledgeSourceIds,
    productIds: options.productIds,
    limit: options.productIds.length,
    offset: 0,
  });
  const rowsById = new Map(rows.map((row) => [row.productId, row]));

  return options.productIds
    .map((productId) => rowsById.get(productId))
    .filter((row): row is CatalogProductRow => row !== undefined);
}

function normalizeProductReferences(
  products: CatalogProductReference[],
): CatalogProductReference[] {
  const seen = new Set<string>();
  return products
    .map((product) => {
      const productId = product.productId?.trim() || undefined;
      const title = product.title?.trim() || undefined;
      const terms = normalizeTerms(product.terms ?? []);
      return {
        productId,
        title,
        terms: terms.length > 0 ? terms : undefined,
      };
    })
    .filter((product) => product.productId || product.title || product.terms)
    .filter((product) => {
      const key = normalizeCatalogValue(
        product.productId ??
          product.title ??
          (product.terms ?? [])
            .map((term) => `${term.fieldPath ?? "*"}:${term.value}`)
            .join("|"),
      );
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_DETAIL_PRODUCTS);
}

async function findValidatedProductIds(options: {
  agentId: string;
  knowledgeSourceIds?: string[];
  terms: CatalogSearchTerm[];
  mode: CatalogSearchMode;
}): Promise<{ productIds: string[]; terms: CatalogSearchTerm[] }> {
  const productIdsByTerm: Array<Set<string>> = [];
  const orderingFacts: CandidateFactRow[] = [];
  const resolvedTerms: CatalogSearchTerm[] = [];

  for (const term of options.terms) {
    const result = await findAuthoritativeRowsForTerm({
      ...options,
      term,
    });
    const authoritativeRows = result.rows;
    const productIds = new Set(authoritativeRows.map((row) => row.productId));
    productIdsByTerm.push(productIds);
    orderingFacts.push(...authoritativeRows);
    resolvedTerms.push(result.resolvedTerm ?? stripValidationCandidates(term));
  }

  if (productIdsByTerm.some((productIds) => productIds.size === 0)) {
    return { productIds: [], terms: resolvedTerms };
  }
  const [firstProductIds, ...remainingProductIds] = productIdsByTerm;
  const seen = new Set<string>();
  const orderedProductIds: string[] = [];

  for (const row of orderingFacts) {
    if (!firstProductIds.has(row.productId) || seen.has(row.productId)) {
      continue;
    }
    if (
      remainingProductIds.every((productIds) => productIds.has(row.productId))
    ) {
      seen.add(row.productId);
      orderedProductIds.push(row.productId);
    }
  }

  return { productIds: orderedProductIds, terms: resolvedTerms };
}

async function findAuthoritativeRowsForTerm(options: {
  agentId: string;
  knowledgeSourceIds?: string[];
  term: CatalogSearchTerm;
  mode: CatalogSearchMode;
}): Promise<{
  rows: CandidateFactRow[];
  resolvedTerm?: CatalogSearchTerm;
}> {
  const attempts: CatalogSearchTermCandidate[] = [
    stripValidationCandidates(options.term),
  ];
  if (options.term.fieldPath) {
    attempts.push({ value: options.term.value });
  }
  attempts.push(...deriveCatalogTermFallbacks(options.term.value));
  attempts.push(...(options.term.validationCandidates ?? []));

  const seen = new Set<string>();
  for (const attempt of attempts) {
    const key = normalizeCatalogValue(
      `${attempt.fieldPath ?? "*"}:${attempt.value}`,
    );
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const rows = await findCandidateFactsForTerm({
      ...options,
      term: attempt,
    });
    if (attempt.fieldPath) {
      rows.push(
        ...(await findCandidateFactsForTerm({
          ...options,
          term: { value: attempt.value },
        })),
      );
    }

    const authoritativeRows = selectAuthoritativeRows(
      dedupeCandidateRows(rows),
    );
    if (authoritativeRows.length > 0) {
      return {
        rows: authoritativeRows,
        resolvedTerm: {
          value: attempt.value,
          fieldPath: attempt.fieldPath,
        },
      };
    }
  }

  return { rows: [] };
}

async function findCandidateFactsForTerm(options: {
  agentId: string;
  knowledgeSourceIds?: string[];
  term: CatalogSearchTerm;
  mode: CatalogSearchMode;
}): Promise<CandidateFactRow[]> {
  const fieldFilter = options.term.fieldPath
    ? eq(catalogProductFact.fieldPath, options.term.fieldPath)
    : undefined;
  const stableKeyValue = normalizeCatalogFactValue(
    "stable_key",
    options.term.value,
  );
  const exactValue = normalizeCatalogFactValue("exact", options.term.value);
  const titleValue = normalizeCatalogFactValue("title", options.term.value);
  const filterableValue = normalizeCatalogFactValue(
    "filterable",
    options.term.value,
  );
  const searchableValue = normalizeCatalogFactValue(
    "searchable",
    options.term.value,
  );

  const indexedRows = await db
    .select({
      productId: catalogProductFact.productId,
      role: catalogProductFact.role,
      fieldPath: catalogProductFact.fieldPath,
      normalizedValue: catalogProductFact.normalizedValue,
    })
    .from(catalogProductFact)
    .innerJoin(
      catalogProduct,
      eq(catalogProduct.id, catalogProductFact.productId),
    )
    .innerJoin(
      catalogConfig,
      eq(catalogConfig.knowledgeSourceId, catalogProduct.sourceId),
    )
    .innerJoin(knowledgeSource, eq(knowledgeSource.id, catalogProduct.sourceId))
    .where(
      and(
        buildActiveCatalogProductWhere(options),
        eq(catalogProductFact.indexVersion, catalogProduct.indexVersion),
        fieldFilter,
        or(
          and(
            eq(catalogProductFact.role, "filterable"),
            eq(catalogProductFact.normalizedValue, filterableValue),
          ),
          and(
            eq(catalogProductFact.role, "stable_key"),
            eq(catalogProductFact.normalizedValue, stableKeyValue),
          ),
          and(
            eq(catalogProductFact.role, "exact"),
            eq(catalogProductFact.normalizedValue, exactValue),
          ),
          and(
            eq(catalogProductFact.role, "title"),
            sql`instr(${catalogProductFact.normalizedValue}, ${titleValue}) = 1`,
          ),
          and(
            eq(catalogProductFact.role, "searchable"),
            sql`instr(${catalogProductFact.normalizedValue}, ${searchableValue}) > 0`,
          ),
        ),
      ),
    );

  const filteredIndexedRows = indexedRows.filter((row) =>
    candidateFactAllowedForMode(row, options.mode),
  );
  if (filteredIndexedRows.length > 0) return filteredIndexedRows;

  return findCandidateFactsByNormalizedScan({
    ...options,
    fieldFilter,
    stableKeyValue,
    exactValue,
    titleValue,
    filterableValue,
    searchableValue,
    mode: options.mode,
  });
}

async function findCandidateFactsByNormalizedScan(options: {
  agentId: string;
  knowledgeSourceIds?: string[];
  term: CatalogSearchTerm;
  fieldFilter?: SQL<unknown>;
  stableKeyValue: string;
  exactValue: string;
  titleValue: string;
  filterableValue: string;
  searchableValue: string;
  mode: CatalogSearchMode;
}): Promise<CandidateFactRow[]> {
  if (
    !options.stableKeyValue &&
    !options.exactValue &&
    !options.titleValue &&
    !options.filterableValue &&
    !options.searchableValue
  ) {
    return [];
  }

  const rows = await db
    .select({
      productId: catalogProductFact.productId,
      role: catalogProductFact.role,
      fieldPath: catalogProductFact.fieldPath,
      normalizedValue: catalogProductFact.normalizedValue,
    })
    .from(catalogProductFact)
    .innerJoin(
      catalogProduct,
      eq(catalogProduct.id, catalogProductFact.productId),
    )
    .innerJoin(
      catalogConfig,
      eq(catalogConfig.knowledgeSourceId, catalogProduct.sourceId),
    )
    .innerJoin(knowledgeSource, eq(knowledgeSource.id, catalogProduct.sourceId))
    .where(
      and(
        buildActiveCatalogProductWhere(options),
        eq(catalogProductFact.indexVersion, catalogProduct.indexVersion),
        options.fieldFilter,
        inArray(catalogProductFact.role, [
          "filterable",
          "stable_key",
          "exact",
          "title",
          "searchable",
        ]),
      ),
    );

  return rows.filter(
    (row) =>
      candidateFactAllowedForMode(row as CandidateFactRow, options.mode) &&
      normalizedFactRowMatchesTerm(row as CandidateFactRow, options),
  ) as CandidateFactRow[];
}

function candidateFactAllowedForMode(
  row: Pick<CandidateFactRow, "role" | "fieldPath">,
  mode: CatalogSearchMode,
) {
  if (row.role !== "searchable") return true;
  if (mode === "detail") return true;
  return isInventorySearchableField(row.fieldPath);
}

function isInventorySearchableField(fieldPath: string) {
  const normalized = fieldPath.toLocaleLowerCase();
  return (
    normalized.includes("general-information.name") ||
    normalized === "category" ||
    normalized.endsWith(".category")
  );
}

function normalizedFactRowMatchesTerm(
  row: CandidateFactRow,
  options: {
    stableKeyValue: string;
    exactValue: string;
    titleValue: string;
    filterableValue: string;
    searchableValue: string;
  },
): boolean {
  const value = normalizeCatalogFactValue(row.role, row.normalizedValue);

  switch (row.role) {
    case "filterable":
      return value === options.filterableValue;
    case "stable_key":
      return value === options.stableKeyValue;
    case "exact":
      return value === options.exactValue;
    case "title":
      return value.startsWith(options.titleValue);
    case "searchable": {
      const tokens = options.searchableValue
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);
      return (
        tokens.length > 0 &&
        tokens.every((token) =>
          getCatalogSearchableQueryCandidates(token).some((candidate) =>
            value.includes(candidate),
          ),
        )
      );
    }
  }
}

function selectAuthoritativeRows(rows: CandidateFactRow[]): CandidateFactRow[] {
  const roleOrder: CandidateFactRow["role"][][] = [
    ["filterable"],
    ["stable_key", "exact"],
    ["title"],
    ["searchable"],
  ];

  for (const roles of roleOrder) {
    const selected = rows.filter((row) => roles.includes(row.role));
    if (selected.length > 0) return selected;
  }

  return [];
}

function dedupeCandidateRows(rows: CandidateFactRow[]): CandidateFactRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.productId}:${row.role}:${row.fieldPath}:${row.normalizedValue}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function deriveCatalogTermFallbacks(value: string): CatalogSearchTerm[] {
  const candidates = new Set<string>();
  const tokens = normalizeCatalogValue(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .filter((token) => !CATALOG_QUERY_STOP_TOKENS.has(token))
    .slice(0, 4);

  for (const token of tokens) {
    if (token.length >= 3) candidates.add(token);
    if (token.length >= 6) candidates.add(token.slice(0, -1));
    if (token.length >= 7) candidates.add(token.slice(0, -2));
  }

  return [...candidates]
    .filter((candidate) => candidate.length >= 3)
    .slice(0, 8)
    .map((candidate) => ({ value: candidate }));
}

async function listActiveCatalogProducts(options: {
  agentId: string;
  knowledgeSourceIds?: string[];
  productIds?: string[];
  limit: number;
  offset: number;
}): Promise<CatalogProductRow[]> {
  if (options.productIds && options.productIds.length > PRODUCT_ID_CHUNK_SIZE) {
    const rows: CatalogProductRow[] = [];
    for (const productIdChunk of chunkArray(
      options.productIds,
      PRODUCT_ID_CHUNK_SIZE,
    )) {
      rows.push(
        ...(await queryActiveCatalogProducts({
          ...options,
          productIds: productIdChunk,
          limit: productIdChunk.length,
          offset: 0,
        })),
      );
    }

    return rows
      .sort(compareCatalogProducts)
      .slice(options.offset, options.offset + options.limit);
  }

  return queryActiveCatalogProducts(options);
}

async function queryActiveCatalogProducts(options: {
  agentId: string;
  knowledgeSourceIds?: string[];
  productIds?: string[];
  limit: number;
  offset: number;
}): Promise<CatalogProductRow[]> {
  const productFilter =
    options.productIds && options.productIds.length > 0
      ? inArray(catalogProduct.id, options.productIds)
      : undefined;

  return db
    .select({
      productId: catalogProduct.id,
      sourceId: catalogProduct.sourceId,
      recordKey: catalogProduct.recordKey,
      title: catalogProduct.title,
      data: catalogProduct.data,
      stableKeyField: catalogConfig.stableKeyField,
      titleField: catalogConfig.titleField,
      exactMatchFields: catalogConfig.exactMatchFields,
      filterableFields: catalogConfig.filterableFields,
      searchableFields: catalogConfig.searchableFields,
    })
    .from(catalogProduct)
    .innerJoin(
      catalogConfig,
      eq(catalogConfig.knowledgeSourceId, catalogProduct.sourceId),
    )
    .innerJoin(knowledgeSource, eq(knowledgeSource.id, catalogProduct.sourceId))
    .where(and(buildActiveCatalogProductWhere(options), productFilter))
    .orderBy(asc(catalogProduct.title), asc(catalogProduct.recordKey))
    .limit(options.limit)
    .offset(options.offset);
}

function formatProductEvidence(
  row: CatalogProductRow,
  options: { includeSearchableFields?: boolean } = {},
): CatalogProductEvidence {
  const data = row.data ?? {};
  const factMap = new Map<string, string>();
  factMap.set("recordKey", row.recordKey);

  for (const fieldPath of uniqueFieldList([
    row.stableKeyField,
    row.titleField,
    ...(row.exactMatchFields ?? []),
    ...(row.filterableFields ?? []),
    ...(options.includeSearchableFields ? (row.searchableFields ?? []) : []),
  ])) {
    const value = stringifyScalar(getPathValue(data, fieldPath));
    if (value && !factMap.has(fieldPath)) {
      factMap.set(fieldPath, value);
    }
  }

  return {
    productId: row.productId,
    sourceId: row.sourceId,
    recordKey: row.recordKey,
    title: row.title || row.recordKey,
    facts: [...factMap.entries()].map(([fieldPath, value]) => ({
      fieldPath,
      value,
    })),
  };
}

function normalizeTerms(terms: CatalogSearchTerm[]): CatalogSearchTerm[] {
  const seen = new Set<string>();
  return terms
    .map((term) => ({
      value: term.value.trim(),
      fieldPath: term.fieldPath?.trim() || undefined,
      validationCandidates: normalizeValidationCandidates(
        term.validationCandidates,
      ),
    }))
    .filter((term) => {
      const key = normalizeCatalogValue(
        `${term.fieldPath ?? "*"}:${term.value}`,
      );
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalizeValidationCandidates(
  candidates: CatalogSearchTermCandidate[] | undefined,
): CatalogSearchTermCandidate[] | undefined {
  if (!Array.isArray(candidates) || candidates.length === 0) return undefined;

  const seen = new Set<string>();
  const normalized = candidates
    .map((candidate) => ({
      value: candidate.value.trim(),
      fieldPath: candidate.fieldPath?.trim() || undefined,
    }))
    .filter((candidate) => {
      const key = normalizeCatalogValue(
        `${candidate.fieldPath ?? "*"}:${candidate.value}`,
      );
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  return normalized.length > 0 ? normalized : undefined;
}

function stripValidationCandidates(
  term: CatalogSearchTerm,
): CatalogSearchTermCandidate {
  return {
    value: term.value,
    fieldPath: term.fieldPath,
  };
}

function noMatch(options: {
  terms: CatalogSearchTerm[];
  totalActiveProducts: number;
  code:
    | "catalog_unavailable"
    | "empty_terms"
    | "no_match"
    | "continuation_unavailable";
  message: string;
}): { evidence: CatalogEvidence; diagnostics: CatalogEvidenceDiagnostics } {
  const evidence: CatalogEvidence = {
    kind: "no_match",
    terms: options.terms,
    totalActiveProducts: options.totalActiveProducts,
    code: options.code,
    message: options.message,
  };
  return {
    evidence,
    diagnostics: {
      attempted: true,
      evidenceKind: evidence.kind,
      validationResult: "no_match" as const,
      errorCode: options.code,
      matchedProducts: 0,
      returnedProducts: 0,
    },
  };
}

function selectCatalogPlan(plan: RetrievalPlan): RetrievalPlan | undefined {
  if (plan.kind === "mixed") {
    return plan.plans.find((child) => child.kind.startsWith("catalog_"));
  }
  return plan.kind.startsWith("catalog_") ? plan : undefined;
}

function formatScopeLabel(
  capabilities: SourceCapabilities,
  scopeSourceIds: string[],
) {
  const sourceIdSet = new Set(scopeSourceIds);
  const labels = capabilities.catalog.scopes
    .filter((scope) => sourceIdSet.has(scope.sourceId))
    .map((scope) => scope.name || scope.aliases[0])
    .filter((label): label is string => Boolean(label));

  return labels.length > 0 ? labels.join(", ") : undefined;
}

function mergeKnowledgeSourceIds(
  baseIds: string[] | undefined,
  scopeIds: string[] | undefined,
) {
  const normalizedScopeIds = normalizeStringList(scopeIds);
  if (normalizedScopeIds.length === 0) return baseIds;

  const normalizedBaseIds = normalizeStringList(baseIds);
  if (normalizedBaseIds.length === 0) return normalizedScopeIds;

  const scopeSet = new Set(normalizedScopeIds);
  return normalizedBaseIds.filter((id) => scopeSet.has(id));
}

function normalizeStringList(values: string[] | undefined) {
  if (!values) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    normalized.push(text);
  }
  return normalized;
}

function normalizeLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return DEFAULT_PAGE_LIMIT;
  }
  return Math.max(1, Math.min(Math.floor(limit), MAX_PAGE_LIMIT));
}

function compareCatalogProducts(
  left: CatalogProductRow,
  right: CatalogProductRow,
) {
  return (
    (left.title ?? "").localeCompare(right.title ?? "") ||
    left.recordKey.localeCompare(right.recordKey)
  );
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

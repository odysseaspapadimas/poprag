import type {
  CatalogEvidence,
  RetrievalCatalogFocus,
  RetrievalCatalogProductFocus,
  RetrievalPageCursor,
} from "./types";

export function makeCatalogPageCursor(
  evidence: CatalogEvidence | undefined,
): RetrievalPageCursor | undefined {
  if (!evidence || evidence.kind !== "product_page") return undefined;
  return {
    kind: "catalog_page",
    planKind: "catalog_search",
    terms: evidence.terms,
    scopeSourceIds: evidence.scopeSourceIds,
    offset: evidence.offset,
    limit: evidence.limit,
    nextOffset: evidence.nextOffset,
    hasMore: evidence.hasMore,
  };
}

export function makeCatalogFocus(
  evidence: CatalogEvidence | undefined,
): RetrievalCatalogFocus | undefined {
  if (!evidence) return undefined;

  if (
    evidence.kind === "product_page" &&
    (evidence.terms.length > 0 || evidence.scopeSourceIds?.length)
  ) {
    return {
      kind: "catalog_focus",
      planKind: "catalog_search",
      terms: evidence.terms,
      scopeSourceIds: evidence.scopeSourceIds,
      matchedProducts: evidence.matchedProducts,
    };
  }

  if (
    evidence.kind === "count" &&
    (evidence.terms.length > 0 || evidence.scopeSourceIds?.length)
  ) {
    return {
      kind: "catalog_focus",
      planKind: "catalog_count",
      terms: evidence.terms,
      scopeSourceIds: evidence.scopeSourceIds,
      matchedProducts: evidence.matchedProducts,
    };
  }

  return undefined;
}

export function makeCatalogProductFocus(
  evidence: CatalogEvidence | undefined,
): RetrievalCatalogProductFocus | undefined {
  if (!evidence) return undefined;

  if (evidence.kind === "product_page") {
    return createProductFocus({
      terms: evidence.terms,
      matchedProducts: evidence.matchedProducts,
      products: evidence.products,
    });
  }

  if (evidence.kind === "product_detail") {
    return createProductFocus({
      terms: [],
      matchedProducts: evidence.matchedProducts,
      products: evidence.products,
    });
  }

  return undefined;
}

function createProductFocus(options: {
  terms: RetrievalCatalogProductFocus["terms"];
  matchedProducts: number;
  products: Array<{ productId: string; title: string; recordKey: string }>;
}): RetrievalCatalogProductFocus | undefined {
  if (options.products.length === 0) return undefined;

  return {
    kind: "catalog_product_focus",
    terms: options.terms,
    matchedProducts: options.matchedProducts,
    products: options.products.slice(0, 20).map((product) => ({
      productId: product.productId,
      title: product.title,
      recordKey: product.recordKey,
    })),
  };
}

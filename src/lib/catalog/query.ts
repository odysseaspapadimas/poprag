import { and, asc, count, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  catalogConfig,
  catalogProduct,
  catalogProductFact,
  documentChunks,
  knowledgeSource,
} from "@/db/schema";
import {
  type CatalogFieldRole,
  type CatalogFilterValueSummary,
  formatCatalogFilterValueSummaryLines,
  getCatalogSearchableQueryCandidates,
  getPathValue,
  isCatalogTitlePrefixCandidate,
  normalizeCatalogFactValue,
  normalizeCatalogQueryForRole,
  normalizeCatalogValue,
  selectCatalogFilteredProductIds,
  stringifyScalar,
  uniqueFieldList,
} from "./shared";

export type { CatalogFilterValueSummary } from "./shared";

export interface CatalogExactMatch {
  id: string;
  score: number;
  vectorScore?: number;
  content: string;
  metadata: Record<string, unknown>;
}

export type CatalogStructuredIntent =
  | "count"
  | "overview"
  | "list"
  | "filter"
  | "continue_list"
  | "capabilities";

export type CatalogStructuredLookupIntent = Exclude<
  CatalogStructuredIntent,
  "continue_list"
>;

export interface CatalogListContinuationState {
  intent: "list" | "filter";
  filters: CatalogStructuredFilter[];
  offset: number;
  limit: number;
  nextOffset: number;
  hasMore: boolean;
}

export interface CatalogStructuredFilter {
  value: string;
  fieldPath?: string;
}

export interface CatalogFieldCapability {
  fieldPath: string;
  role: CatalogFieldRole;
}

export interface CatalogStructuredQueryResult {
  intent: CatalogStructuredLookupIntent;
  totalActiveProducts: number;
  matchedProducts: number;
  returnedProducts: number;
  filterValueSummaries: CatalogFilterValueSummary[];
  filters: CatalogStructuredFilter[];
  offset: number;
  limit: number;
  nextOffset: number;
  hasMore: boolean;
  complete: boolean;
  match: CatalogExactMatch;
}

type CatalogStructuredProductRow = {
  productId: string;
  sourceId: string;
  recordKey: string;
  title: string | null;
  data: Record<string, unknown> | null;
  fileName: string | null;
  stableKeyField: string;
  titleField: string;
  exactMatchFields: string[] | null;
  searchableFields: string[] | null;
  filterableFields: string[] | null;
};

const PRODUCT_ID_FILTER_CHUNK_SIZE = 80;

export async function countActiveCatalogProducts(options: {
  agentId: string;
  knowledgeSourceIds?: string[];
}): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(catalogProduct)
    .innerJoin(
      catalogConfig,
      eq(catalogConfig.knowledgeSourceId, catalogProduct.sourceId),
    )
    .innerJoin(knowledgeSource, eq(knowledgeSource.id, catalogProduct.sourceId))
    .where(buildStructuredInventoryProductWhere(options));

  return Number(row?.total ?? 0);
}

export async function listCatalogFieldCapabilities(options: {
  agentId: string;
  knowledgeSourceIds?: string[];
}): Promise<CatalogFieldCapability[]> {
  const rows = await db
    .select({
      stableKeyField: catalogConfig.stableKeyField,
      titleField: catalogConfig.titleField,
      exactMatchFields: catalogConfig.exactMatchFields,
      searchableFields: catalogConfig.searchableFields,
      filterableFields: catalogConfig.filterableFields,
    })
    .from(catalogConfig)
    .innerJoin(
      knowledgeSource,
      eq(knowledgeSource.id, catalogConfig.knowledgeSourceId),
    )
    .where(buildActiveCatalogConfigWhere(options));

  const capabilities: CatalogFieldCapability[] = [];
  for (const row of rows) {
    capabilities.push({ fieldPath: row.stableKeyField, role: "stable_key" });
    capabilities.push({ fieldPath: row.titleField, role: "title" });
    for (const fieldPath of row.exactMatchFields ?? []) {
      capabilities.push({ fieldPath, role: "exact" });
    }
    for (const fieldPath of row.searchableFields ?? []) {
      capabilities.push({ fieldPath, role: "searchable" });
    }
    for (const fieldPath of row.filterableFields ?? []) {
      capabilities.push({ fieldPath, role: "filterable" });
    }
  }

  return dedupeCatalogCapabilities(capabilities);
}

export async function listCatalogFilterValueSummaries(options: {
  agentId: string;
  knowledgeSourceIds?: string[];
  limit?: number;
}): Promise<CatalogFilterValueSummary[]> {
  const rows = await db
    .select({
      fieldPath: catalogProductFact.fieldPath,
      value: catalogProductFact.value,
      normalizedValue: catalogProductFact.normalizedValue,
      productCount: count(),
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
        buildStructuredInventoryProductWhere(options),
        eq(catalogProductFact.role, "filterable"),
      ),
    )
    .groupBy(
      catalogProductFact.fieldPath,
      catalogProductFact.value,
      catalogProductFact.normalizedValue,
    )
    .orderBy(
      asc(catalogProductFact.fieldPath),
      desc(count()),
      asc(catalogProductFact.value),
    )
    .limit(Math.max(1, Math.min(options.limit ?? 500, 1000)));

  return rows.map((row) => ({
    fieldPath: row.fieldPath,
    value: row.value,
    normalizedValue: row.normalizedValue,
    productCount: Number(row.productCount),
  }));
}

export async function findCatalogExactMatches(options: {
  query: string;
  agentId: string;
  knowledgeSourceIds?: string[];
  limit?: number;
}): Promise<CatalogExactMatch[]> {
  const normalizedQuery = normalizeCatalogValue(options.query);
  if (!normalizedQuery) return [];
  const stableKeyQuery = normalizeCatalogQueryForRole(
    "stable_key",
    options.query,
  );
  const exactQuery = normalizeCatalogQueryForRole("exact", options.query);
  const titleQuery = normalizeCatalogQueryForRole("title", options.query);
  const allowTitlePrefix = isCatalogTitlePrefixCandidate(options.query);

  const sourceFilter =
    options.knowledgeSourceIds && options.knowledgeSourceIds.length > 0
      ? inArray(catalogProduct.sourceId, options.knowledgeSourceIds)
      : undefined;

  const titleMatch = allowTitlePrefix
    ? or(
        eq(catalogProductFact.normalizedValue, titleQuery),
        catalogFactStartsWith(titleQuery),
      )
    : eq(catalogProductFact.normalizedValue, titleQuery);

  const rows = await db
    .select({
      productId: catalogProduct.id,
      sourceId: catalogProduct.sourceId,
      recordKey: catalogProduct.recordKey,
      title: catalogProduct.title,
      fileName: knowledgeSource.fileName,
      fieldValue: catalogProductFact.value,
      normalizedValue: catalogProductFact.normalizedValue,
      role: catalogProductFact.role,
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
        eq(catalogProduct.agentId, options.agentId),
        eq(catalogProduct.status, "active"),
        eq(catalogConfig.enabled, true),
        eq(catalogProduct.indexVersion, catalogConfig.activeIndexVersion),
        sourceFilter,
        or(
          and(
            eq(catalogProductFact.role, "stable_key"),
            eq(catalogProductFact.normalizedValue, stableKeyQuery),
          ),
          and(
            eq(catalogProductFact.role, "exact"),
            eq(catalogProductFact.normalizedValue, exactQuery),
          ),
          and(eq(catalogProductFact.role, "title"), titleMatch),
        ),
      ),
    )
    .limit(200);

  const scoredProducts = Array.from(
    rows
      .reduce((map, row) => {
        const exactHit =
          (row.role === "stable_key" &&
            row.normalizedValue === stableKeyQuery) ||
          (row.role === "exact" && row.normalizedValue === exactQuery) ||
          (row.role === "title" && row.normalizedValue === titleQuery);
        const current = map.get(row.productId);
        const score = exactHit
          ? row.role === "title"
            ? 1.2
            : 1.3
          : row.role === "title"
            ? 1.1
            : 1;
        if (!current || score > current.score) {
          map.set(row.productId, { ...row, score });
        }
        return map;
      }, new Map<string, (typeof rows)[number] & { score: number }>())
      .values(),
  )
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit ?? 5);

  if (scoredProducts.length === 0) return [];

  const chunksByProduct = await firstChunkByProduct(
    scoredProducts.map((product) => product.productId),
  );

  return scoredProducts.flatMap((product) => {
    const chunk = chunksByProduct.get(product.productId);
    if (!chunk) return [];

    return {
      id: chunk.id,
      content: chunk.text,
      score: product.score,
      metadata: {
        ...(chunk.metadata ?? {}),
        sourceId: product.sourceId,
        documentId: product.sourceId,
        productId: product.productId,
        recordKey: product.recordKey,
        title: product.title,
        fileName: product.fileName,
        chunkIndex: chunk.chunkIndex,
        matchedValue: product.fieldValue,
        catalogExactMatch: true,
      },
    };
  });
}

export async function findCatalogStructuredQueryResult(options: {
  intent: CatalogStructuredLookupIntent;
  agentId: string;
  knowledgeSourceIds?: string[];
  filters?: CatalogStructuredFilter[];
  limit?: number;
  offset?: number;
  totalActiveProducts?: number;
  fieldCapabilities?: CatalogFieldCapability[];
}): Promise<CatalogStructuredQueryResult | null> {
  const filters = normalizeFilters(options.filters ?? []);
  if (options.intent === "filter" && filters.length === 0) return null;

  const totalActiveProducts =
    options.totalActiveProducts ?? (await countActiveCatalogProducts(options));
  if (totalActiveProducts === 0) return null;
  const fieldCapabilities =
    options.fieldCapabilities ?? (await listCatalogFieldCapabilities(options));
  const filterValueSummaries =
    options.intent === "capabilities" || options.intent === "overview"
      ? await listCatalogFilterValueSummaries(options)
      : [];
  const productLimit =
    options.intent === "count" ||
    options.intent === "capabilities" ||
    options.intent === "overview"
      ? 0
      : Math.max(1, Math.min(options.limit ?? 30, 50));
  const offset = productLimit > 0 ? normalizeOffset(options.offset) : 0;
  const productIds =
    options.intent === "filter" || filters.length > 0
      ? await findFilteredProductIds({
          agentId: options.agentId,
          knowledgeSourceIds: options.knowledgeSourceIds,
          filters,
        })
      : undefined;

  if (filters.length > 0 && productIds?.length === 0) {
    return {
      intent: "filter",
      totalActiveProducts,
      matchedProducts: 0,
      returnedProducts: 0,
      filterValueSummaries,
      filters,
      offset: 0,
      limit: productLimit,
      nextOffset: 0,
      hasMore: false,
      complete: true,
      match: {
        id: `catalog-structured:${options.agentId}:filter:none`,
        score: 2,
        content: buildCatalogStructuredContent({
          intent: "filter",
          totalActiveProducts,
          matchedProducts: 0,
          products: [],
          filters,
          offset: 0,
          limit: productLimit,
          hasMore: false,
          fieldCapabilities,
          filterValueSummaries,
        }),
        metadata: {
          catalogStructuredQuery: true,
          catalogStructuredIntent: "filter",
          totalActiveProducts,
          matchedProducts: 0,
          productsReturned: 0,
          filterValueSummaries,
          filters,
          offset: 0,
          limit: productLimit,
          nextOffset: 0,
          hasMore: false,
          complete: true,
          sourceId: `catalog:${options.agentId}`,
          fileName: "Catalog inventory",
        },
      },
    };
  }

  const products =
    productLimit > 0
      ? await listActiveCatalogProducts({
          ...options,
          productIds,
          limit: productLimit,
          offset,
        })
      : [];
  const matchedProducts = productIds?.length ?? totalActiveProducts;
  const nextOffset = productLimit > 0 ? offset + products.length : 0;
  const hasMore = productLimit > 0 ? nextOffset < matchedProducts : false;
  const complete = !hasMore;

  const resultIntent =
    options.intent === "count"
      ? "count"
      : filters.length > 0
        ? "filter"
        : options.intent;

  const content = buildCatalogStructuredContent({
    intent: resultIntent,
    totalActiveProducts,
    matchedProducts,
    products,
    filters,
    offset,
    limit: productLimit,
    hasMore,
    fieldCapabilities,
    filterValueSummaries,
  });

  return {
    intent: resultIntent,
    totalActiveProducts,
    matchedProducts,
    returnedProducts: products.length,
    filterValueSummaries,
    filters,
    offset,
    limit: productLimit,
    nextOffset,
    hasMore,
    complete,
    match: {
      id: `catalog-structured:${options.agentId}:${options.intent}:${offset}`,
      score: 2,
      content,
      metadata: {
        catalogStructuredQuery: true,
        catalogStructuredIntent: resultIntent,
        totalActiveProducts,
        matchedProducts,
        productsReturned: products.length,
        filterValueSummaries,
        filters,
        offset,
        limit: productLimit,
        nextOffset,
        hasMore,
        complete,
        sourceId: products[0]?.sourceId ?? `catalog:${options.agentId}`,
        fileName: "Catalog inventory",
      },
    },
  };
}

async function findFilteredProductIds(options: {
  agentId: string;
  knowledgeSourceIds?: string[];
  filters: CatalogStructuredFilter[];
}): Promise<string[]> {
  if (options.filters.length === 0) return [];

  const sourceFilter =
    options.knowledgeSourceIds && options.knowledgeSourceIds.length > 0
      ? inArray(catalogProduct.sourceId, options.knowledgeSourceIds)
      : undefined;
  const filterValues = options.filters
    .map((filter) => normalizeCatalogValue(filter.value))
    .filter(Boolean);
  if (filterValues.length === 0) return [];
  const exactFilterValues = options.filters
    .map((filter) => normalizeCatalogFactValue("exact", filter.value))
    .filter(Boolean);
  const searchableFilterValues = Array.from(
    new Set(filterValues.flatMap(getCatalogSearchableQueryCandidates)),
  );

  const rows = await db
    .select({
      productId: catalogProduct.id,
      normalizedValue: catalogProductFact.normalizedValue,
      fieldPath: catalogProductFact.fieldPath,
      role: catalogProductFact.role,
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
        eq(catalogProduct.agentId, options.agentId),
        eq(catalogProduct.status, "active"),
        eq(catalogConfig.enabled, true),
        eq(catalogProduct.indexVersion, catalogConfig.activeIndexVersion),
        sourceFilter,
        or(
          and(
            eq(catalogProductFact.role, "filterable"),
            inArray(catalogProductFact.normalizedValue, filterValues),
          ),
          and(
            eq(catalogProductFact.role, "stable_key"),
            inArray(catalogProductFact.normalizedValue, exactFilterValues),
          ),
          and(
            eq(catalogProductFact.role, "exact"),
            inArray(catalogProductFact.normalizedValue, exactFilterValues),
          ),
          and(
            eq(catalogProductFact.role, "title"),
            or(...filterValues.map(catalogFactStartsWith)),
          ),
          and(
            eq(catalogProductFact.role, "searchable"),
            or(...searchableFilterValues.map(catalogFactContains)),
          ),
        ),
      ),
    );

  return selectCatalogFilteredProductIds(options.filters, rows);
}

async function listActiveCatalogProducts(options: {
  agentId: string;
  knowledgeSourceIds?: string[];
  productIds?: string[];
  limit: number;
  offset: number;
}): Promise<CatalogStructuredProductRow[]> {
  if (
    options.productIds &&
    options.productIds.length > PRODUCT_ID_FILTER_CHUNK_SIZE
  ) {
    const rows: CatalogStructuredProductRow[] = [];
    for (const productIdChunk of chunkArray(
      options.productIds,
      PRODUCT_ID_FILTER_CHUNK_SIZE,
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
      .sort(compareCatalogStructuredProductRows)
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
}): Promise<CatalogStructuredProductRow[]> {
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
      fileName: knowledgeSource.fileName,
      stableKeyField: catalogConfig.stableKeyField,
      titleField: catalogConfig.titleField,
      exactMatchFields: catalogConfig.exactMatchFields,
      searchableFields: catalogConfig.searchableFields,
      filterableFields: catalogConfig.filterableFields,
    })
    .from(catalogProduct)
    .innerJoin(
      catalogConfig,
      eq(catalogConfig.knowledgeSourceId, catalogProduct.sourceId),
    )
    .innerJoin(knowledgeSource, eq(knowledgeSource.id, catalogProduct.sourceId))
    .where(and(buildStructuredInventoryProductWhere(options), productFilter))
    .orderBy(asc(catalogProduct.title), asc(catalogProduct.recordKey))
    .limit(options.limit)
    .offset(options.offset);
}

function buildActiveCatalogProductWhere(options: {
  agentId: string;
  knowledgeSourceIds?: string[];
}) {
  const sourceFilter =
    options.knowledgeSourceIds && options.knowledgeSourceIds.length > 0
      ? inArray(catalogProduct.sourceId, options.knowledgeSourceIds)
      : undefined;

  return and(
    eq(catalogProduct.agentId, options.agentId),
    eq(catalogProduct.status, "active"),
    eq(catalogConfig.enabled, true),
    eq(catalogProduct.indexVersion, catalogConfig.activeIndexVersion),
    sourceFilter,
  );
}

function buildStructuredInventoryProductWhere(options: {
  agentId: string;
  knowledgeSourceIds?: string[];
}) {
  return and(
    buildActiveCatalogProductWhere(options),
    sql`(
      coalesce(json_array_length(${catalogConfig.filterableFields}), 0) = 0
      or exists (
        select 1
        from ${catalogProductFact}
        where ${catalogProductFact.productId} = ${catalogProduct.id}
          and ${catalogProductFact.indexVersion} = ${catalogProduct.indexVersion}
          and ${catalogProductFact.role} = 'filterable'
      )
    )`,
  );
}

function buildActiveCatalogConfigWhere(options: {
  agentId: string;
  knowledgeSourceIds?: string[];
}) {
  const sourceFilter =
    options.knowledgeSourceIds && options.knowledgeSourceIds.length > 0
      ? inArray(catalogConfig.knowledgeSourceId, options.knowledgeSourceIds)
      : undefined;

  return and(
    eq(catalogConfig.agentId, options.agentId),
    eq(catalogConfig.enabled, true),
    sourceFilter,
  );
}

function buildCatalogStructuredContent(options: {
  intent: CatalogStructuredLookupIntent;
  totalActiveProducts: number;
  matchedProducts: number;
  products: CatalogStructuredProductRow[];
  filters: CatalogStructuredFilter[];
  offset: number;
  limit: number;
  hasMore: boolean;
  fieldCapabilities: CatalogFieldCapability[];
  filterValueSummaries: CatalogFilterValueSummary[];
}): string {
  const hasFilters = options.filters.length > 0;
  const lines = [
    "Catalog inventory summary (authoritative structured data from active catalog products).",
    `User inventory intent: ${options.intent}`,
    `Total active products: ${options.totalActiveProducts}`,
    ...formatCatalogCapabilityLines(options.fieldCapabilities),
  ];

  if (hasFilters) {
    lines.push(
      `Applied filters: ${options.filters.map((filter) => filter.value).join(", ")}`,
      `Matching active products: ${options.matchedProducts}`,
    );
    if (options.intent !== "count") {
      lines.push(`Products returned in this page: ${options.products.length}`);
    }
  } else if (options.intent !== "count") {
    lines.push(`Products returned in this page: ${options.products.length}`);
  } else {
    lines.push(`Matching active products: ${options.matchedProducts}`);
  }

  if (options.intent === "capabilities") {
    lines.push(
      "The configured filter values below are global active-catalog values, not scoped to any previous product page or filtered list.",
      ...formatCatalogFilterValueSummaryLines(options.filterValueSummaries),
      "Answer questions about available catalog filters from the configured catalog filter fields above.",
      "For questions about available filter values, answer from the global configured filter values above, not from a previous product page unless the user explicitly scopes the question to that page or filtered list.",
      "If configured catalog filter fields is none, say no dedicated filter fields are configured for this catalog.",
      "You may mention lookup/searchable fields separately as ways to narrow or search, but do not call them configured filters and do not invent fields that are not listed above.",
    );
    return lines.join("\n");
  }

  if (options.intent === "overview") {
    lines.push(
      "This is a broad catalog overview request, not a product page request.",
      "Do not list the first sorted product page.",
      "Answer conversationally with a short overview of what the catalog carries.",
      "Use the available configured filter values below as examples of brands, families, categories, or other configured ways to browse.",
      ...formatCatalogFilterValueSummaryLines(options.filterValueSummaries, 24),
      "Invite the user to ask for a specific brand/category/search term, or to ask for a product list if they want individual products.",
      "Do not use internal phrases like active products, configured filters, structured data, or page offset in the answer.",
    );
    return lines.join("\n");
  }

  if (options.intent === "count" && !hasFilters) {
    lines.push(
      "Answer count questions using the exact total active products above.",
      "Do not describe this as a page or partial product list.",
    );
    return lines.join("\n");
  }
  if (options.intent === "count") {
    lines.push(
      "Answer filtered count questions using the exact matching active products above.",
      "Do not describe this as a page or partial product list.",
    );
    return lines.join("\n");
  }

  lines.push(
    `Catalog page offset: ${options.offset}`,
    `Catalog page limit: ${options.limit}`,
    `Next page offset: ${options.offset + options.products.length}`,
    `Has more products after this page: ${options.hasMore ? "yes" : "no"}`,
  );

  if (options.offset > 0) {
    lines.push(
      "This is a continuation page. Continue the previous catalog inventory answer with the products below; do not repeat earlier products.",
    );
  }

  if (options.products.length === 0) {
    lines.push(
      options.offset > 0
        ? "No products were returned for this continuation page. Answer that there are no more matching active catalog products to show."
        : "No active products matched the requested catalog term(s). Answer that no matching products were found for the user's requested term. Do not claim a brand, category, or type does not exist beyond this exact validated lookup.",
    );
    return lines.join("\n");
  }

  lines.push(
    hasFilters
      ? "For filtered inventory questions, answer from the matching products below. If has more products after this page is yes, say this is a partial filtered list and the user can ask for more."
      : "For broad product-list questions, list the products returned below. This is one sorted page from the active catalog, not a brand, category, or product-family summary. Do not infer that the whole catalog is limited to the first returned brand, category, or product line. If has more products after this page is yes, say this is a partial list and the user can ask for more or narrow using only the configured filter, lookup, or searchable fields listed above. Do not mention unlisted fields as available filters.",
    "",
    "Products:",
  );

  for (const [index, product] of options.products.entries()) {
    lines.push(
      `${options.offset + index + 1}. ${formatCatalogStructuredProduct(product)}`,
    );
  }

  return lines.join("\n");
}

function formatCatalogCapabilityLines(
  capabilities: CatalogFieldCapability[],
): string[] {
  const filterFields = fieldsByRole(capabilities, ["filterable"]);
  const lookupFields = fieldsByRole(capabilities, [
    "stable_key",
    "title",
    "exact",
  ]);
  const searchableFields = fieldsByRole(capabilities, ["searchable"]);

  return [
    `Configured catalog filter fields: ${formatFieldList(filterFields)}`,
    `Catalog lookup fields: ${formatFieldList(lookupFields)}`,
    `Catalog searchable fields: ${formatFieldList(searchableFields)}`,
  ];
}

function fieldsByRole(
  capabilities: CatalogFieldCapability[],
  roles: CatalogFieldRole[],
): string[] {
  const roleSet = new Set<CatalogFieldRole>(roles);
  return uniqueFieldList(
    capabilities
      .filter((capability) => roleSet.has(capability.role))
      .map((capability) => capability.fieldPath),
  );
}

function formatFieldList(fields: string[]): string {
  return fields.length > 0 ? fields.join(", ") : "none";
}

function compareCatalogStructuredProductRows(
  left: CatalogStructuredProductRow,
  right: CatalogStructuredProductRow,
): number {
  return (
    compareCatalogText(left.title ?? "", right.title ?? "") ||
    compareCatalogText(left.recordKey, right.recordKey)
  );
}

function compareCatalogText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function normalizeOffset(offset: number | undefined): number {
  if (typeof offset !== "number" || !Number.isFinite(offset)) return 0;
  return Math.max(0, Math.floor(offset));
}

function formatCatalogStructuredProduct(
  product: CatalogStructuredProductRow,
): string {
  const data = product.data ?? {};
  const facts = new Map<string, string>();

  facts.set("recordKey", product.recordKey);
  const fields = uniqueFieldList([
    product.stableKeyField,
    product.titleField,
    ...(product.exactMatchFields ?? []),
    ...(product.filterableFields ?? []),
  ]);

  for (const field of fields) {
    const value = stringifyScalar(getPathValue(data, field));
    if (value && !facts.has(field)) facts.set(field, value);
  }

  const factText = [...facts.entries()]
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}: ${value}`)
    .join("; ");

  return `${product.title || product.recordKey}${factText ? ` (${factText})` : ""}`;
}

async function firstChunkByProduct(productIds: string[]) {
  const chunkRows = await db
    .select({
      id: documentChunks.id,
      text: documentChunks.text,
      productId: documentChunks.productId,
      sourceId: documentChunks.documentId,
      chunkIndex: documentChunks.chunkIndex,
      metadata: documentChunks.metadata,
    })
    .from(documentChunks)
    .where(inArray(documentChunks.productId, productIds))
    .orderBy(asc(documentChunks.productId), asc(documentChunks.chunkIndex));

  const firstChunkByProduct = new Map<string, (typeof chunkRows)[number]>();
  for (const chunk of chunkRows) {
    if (chunk.productId && !firstChunkByProduct.has(chunk.productId)) {
      firstChunkByProduct.set(chunk.productId, chunk);
    }
  }
  return firstChunkByProduct;
}

function dedupeCatalogCapabilities(
  capabilities: CatalogFieldCapability[],
): CatalogFieldCapability[] {
  const seen = new Set<string>();
  return capabilities.filter((capability) => {
    const fieldPath = capability.fieldPath.trim();
    if (!fieldPath) return false;
    const key = `${capability.role}:${fieldPath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    capability.fieldPath = fieldPath;
    return true;
  });
}

function normalizeFilters(filters: CatalogStructuredFilter[]) {
  const seen = new Set<string>();
  return filters
    .map((filter) => {
      const value = filter.value.trim();
      return {
        ...filter,
        value,
        fieldPath: filter.fieldPath?.trim() || undefined,
      };
    })
    .filter((filter) => {
      const key = normalizeCatalogValue(
        `${filter.fieldPath ?? "*"}:${filter.value}`,
      );
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function createCatalogRetrievalLane() {
  return {
    async loadCapabilities(options: {
      agentId: string;
      knowledgeSourceIds?: string[];
    }) {
      const [activeProductCount, fieldCapabilities] = await Promise.all([
        countActiveCatalogProducts(options),
        listCatalogFieldCapabilities(options),
      ]);
      return { activeProductCount, fieldCapabilities };
    },
    findStructuredQueryResult: findCatalogStructuredQueryResult,
    findExactMatches: findCatalogExactMatches,
  };
}

function catalogFactContains(value: string) {
  return sql`instr(${catalogProductFact.normalizedValue}, ${value}) > 0`;
}

function catalogFactStartsWith(value: string) {
  return sql`${catalogProductFact.normalizedValue} LIKE ${`${escapeCatalogLikePattern(value)}%`} ESCAPE '\\'`;
}

function escapeCatalogLikePattern(value: string) {
  return value.replace(/[\\%_]/gu, "\\$&");
}

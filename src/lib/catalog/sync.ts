import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/db";
import {
  type CatalogProduct,
  type CatalogSyncConfig,
  catalogProduct,
  catalogSyncConfig,
  catalogSyncRun,
  documentChunks,
  knowledgeSource,
} from "@/db/schema";
import { CHUNKING_CONFIG } from "@/lib/ai/constants";
import { generateEmbeddings } from "@/lib/ai/embedding";
import { deleteVectorizeIds } from "@/lib/ai/ingestion";

export type CatalogSyncTrigger = "manual" | "scheduled";
export type CatalogSyncMode = "auto" | "diff" | "snapshot";
export type CatalogRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

export interface CatalogSyncWorkflowParams {
  configId?: string;
  trigger?: CatalogSyncTrigger;
  mode?: CatalogSyncMode;
}

export interface CatalogSyncStats {
  fetched: number;
  pagesFetched: number;
  created: number;
  updated: number;
  unchanged: number;
  deactivated: number;
  skipped: number;
  chunksInserted: number;
  vectorsUpserted: number;
}

export interface CatalogExactMatch {
  id: string;
  score: number;
  vectorScore?: number;
  content: string;
  metadata: Record<string, unknown>;
}

export type CatalogStructuredIntent = "count" | "list";

export interface CatalogStructuredQueryResult {
  intent: CatalogStructuredIntent;
  totalActiveProducts: number;
  returnedProducts: number;
  match: CatalogExactMatch;
}

type CatalogStructuredProductRow = {
  productId: string;
  sourceId: string;
  recordKey: string;
  title: string | null;
  data: Record<string, unknown> | null;
  exactMatchFields: string[] | null;
  fileName: string | null;
};

type CatalogSyncConfigRow = CatalogSyncConfig & {
  sourceFileName: string | null;
  sourceR2Key: string | null;
  sourceMime: string | null;
  sourceStatus: string;
};

type NormalizedProduct = {
  id: string;
  recordKey: string;
  recordHash: string;
  title: string;
  searchText: string;
  data: Record<string, unknown>;
  active: boolean;
  updatedAt?: Date;
};

type ProductChunk = {
  id: string;
  text: string;
  chunkIndex: number;
};

const DEFAULT_INACTIVE_VALUES = ["false", "inactive", "deleted", "0", "no"];
const CATALOG_VECTOR_BATCH_SIZE = 20;
const MAX_CATALOG_PAGES = 200;
const CATALOG_PROGRESS_INDEX_START = 15;
const CATALOG_PROGRESS_INDEX_END = 88;

export function computeNextCatalogRunAt(
  config: Pick<
    CatalogSyncConfig,
    "syncIntervalDays" | "scheduleWeekdayUtc" | "scheduleHourUtc"
  >,
  from: Date = new Date(),
): Date {
  const intervalDays = Math.max(1, config.syncIntervalDays || 7);
  const hour = Math.min(23, Math.max(0, config.scheduleHourUtc || 3));
  const weekday = Math.min(6, Math.max(0, config.scheduleWeekdayUtc ?? 1));

  const next = new Date(
    Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth(),
      from.getUTCDate(),
      hour,
      0,
      0,
      0,
    ),
  );

  if (intervalDays === 7) {
    const dayOffset = (weekday - next.getUTCDay() + 7) % 7;
    next.setUTCDate(next.getUTCDate() + dayOffset);
  }

  while (next <= from) {
    next.setUTCDate(next.getUTCDate() + intervalDays);
  }

  return next;
}

export async function runCatalogSyncWorkflow(
  params: CatalogSyncWorkflowParams | undefined,
  env: Env,
  workflowInstanceId: string,
): Promise<{
  processed: number;
  results: Array<{
    configId: string;
    status: CatalogRunStatus;
    runId?: string;
  }>;
}> {
  const trigger = params?.trigger ?? "scheduled";
  const mode = params?.mode ?? "auto";
  const configIds = params?.configId
    ? [params.configId]
    : await listDueCatalogSyncConfigIds();

  const results: Array<{
    configId: string;
    status: CatalogRunStatus;
    runId?: string;
  }> = [];

  for (const configId of configIds) {
    try {
      const result = await syncCatalogConfig(configId, env, {
        trigger,
        mode,
        workflowInstanceId,
      });
      results.push({
        configId,
        status: result.status,
        runId: result.runId,
      });
    } catch (error) {
      console.error(`[Catalog Sync] Config ${configId} failed:`, error);
      results.push({ configId, status: "failed" });
    }
  }

  return { processed: results.length, results };
}

export async function listDueCatalogSyncConfigIds(
  now: Date = new Date(),
): Promise<string[]> {
  const rows = await db
    .select({
      id: catalogSyncConfig.id,
      lastRunStatus: catalogSyncConfig.lastRunStatus,
    })
    .from(catalogSyncConfig)
    .where(
      and(
        eq(catalogSyncConfig.enabled, true),
        or(
          isNull(catalogSyncConfig.nextRunAt),
          lte(catalogSyncConfig.nextRunAt, now),
        ),
      ),
    );

  return rows
    .filter((row) => row.lastRunStatus !== "running")
    .map((row) => row.id);
}

export async function syncCatalogConfig(
  configId: string,
  env: Env,
  options: {
    trigger: CatalogSyncTrigger;
    mode: CatalogSyncMode;
    workflowInstanceId?: string;
  },
): Promise<{
  runId: string;
  status: CatalogRunStatus;
  stats: CatalogSyncStats;
}> {
  const loaded = await loadCatalogSyncConfig(configId);
  if (!loaded) {
    throw new Error(`Catalog sync config ${configId} not found`);
  }

  const now = new Date();
  const runId = nanoid();
  const checkedSince = loaded.cursorLastSuccessfulAt ?? null;
  const resolvedMode =
    options.mode === "auto"
      ? loaded.cursorLastSuccessfulAt
        ? "diff"
        : "snapshot"
      : options.mode;

  await db.insert(catalogSyncRun).values({
    id: runId,
    configId: loaded.id,
    agentId: loaded.agentId,
    knowledgeSourceId: loaded.knowledgeSourceId,
    workflowInstanceId: options.workflowInstanceId,
    trigger: options.trigger,
    mode: resolvedMode,
    status: loaded.enabled ? "running" : "skipped",
    checkedSince,
    startedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  await db
    .update(catalogSyncConfig)
    .set({
      lastRunId: runId,
      lastRunStatus: loaded.enabled ? "running" : "skipped",
      lastRunError: null,
      updatedAt: now,
    })
    .where(eq(catalogSyncConfig.id, loaded.id));

  if (!loaded.enabled) {
    const skippedStats = emptyStats();
    await finishCatalogRun(loaded, runId, "skipped", skippedStats, {
      nextRunAt: computeNextCatalogRunAt(loaded, now),
    });
    return { runId, status: "skipped", stats: skippedStats };
  }

  const stats = emptyStats();

  try {
    await reportCatalogProgress(
      loaded,
      runId,
      stats,
      5,
      "Fetching catalog data",
    );

    const fetchResult = await fetchCatalogPayload(loaded, env, {
      mode: resolvedMode,
      checkedSince,
    });
    const rawR2Key = `agents/${loaded.agentId}/catalog-runs/${runId}/${resolvedMode}.json`;
    await env.R2.put(rawR2Key, JSON.stringify(fetchResult.rawPayload), {
      httpMetadata: { contentType: "application/json" },
    });

    const records = extractCatalogRecords(fetchResult.payload, loaded.itemPath);
    stats.fetched = records.length;
    stats.pagesFetched = fetchResult.pagesFetched;

    await reportCatalogProgress(
      loaded,
      runId,
      stats,
      12,
      `Fetched ${records.length} catalog products across ${fetchResult.pagesFetched} page${fetchResult.pagesFetched === 1 ? "" : "s"}`,
      { rawR2Key },
    );

    const seenRecordKeys = new Set<string>();
    let nextCursorAt = checkedSince ?? now;
    let processedRecords = 0;
    let lastProgressReportAt = 0;

    const maybeReportIndexProgress = async (force = false) => {
      const nowMs = Date.now();
      if (
        !force &&
        processedRecords < records.length &&
        processedRecords % 10 !== 0 &&
        nowMs - lastProgressReportAt < 5000
      ) {
        return;
      }

      lastProgressReportAt = nowMs;
      await reportCatalogProgress(
        loaded,
        runId,
        stats,
        getCatalogIndexProgress(processedRecords, records.length),
        formatCatalogIndexProgressMessage(
          processedRecords,
          records.length,
          stats,
        ),
      );
    };

    await maybeReportIndexProgress(true);

    for (const record of records) {
      try {
        const normalized = await normalizeCatalogRecord(loaded, record);
        if (!normalized) {
          stats.skipped += 1;
          continue;
        }

        seenRecordKeys.add(normalized.recordKey);
        if (normalized.updatedAt && normalized.updatedAt > nextCursorAt) {
          nextCursorAt = normalized.updatedAt;
        }

        if (!normalized.active) {
          const deactivated = await deactivateCatalogProduct(
            loaded,
            normalized.recordKey,
            env,
          );
          if (deactivated) stats.deactivated += 1;
          continue;
        }

        const existing = await findCatalogProduct(
          loaded.knowledgeSourceId,
          normalized.recordKey,
        );

        if (
          existing &&
          existing.status === "active" &&
          existing.recordHash === normalized.recordHash
        ) {
          stats.unchanged += 1;
          await db
            .update(catalogProduct)
            .set({ lastSeenAt: now, updatedAt: now })
            .where(eq(catalogProduct.id, existing.id));
          continue;
        }

        const product = await upsertCatalogProduct(
          loaded,
          normalized,
          existing,
        );
        const indexingResult = await replaceCatalogProductChunks(
          loaded,
          product,
          env,
        );

        stats.chunksInserted += indexingResult.chunksInserted;
        stats.vectorsUpserted += indexingResult.vectorsUpserted;

        if (existing) {
          stats.updated += 1;
        } else {
          stats.created += 1;
        }
      } finally {
        processedRecords += 1;
        await maybeReportIndexProgress();
      }
    }

    await maybeReportIndexProgress(true);

    if (resolvedMode === "snapshot") {
      await reportCatalogProgress(
        loaded,
        runId,
        stats,
        90,
        "Checking for products missing from snapshot",
      );
      const deactivated = await deactivateMissingSnapshotProducts(
        loaded,
        seenRecordKeys,
        env,
      );
      stats.deactivated += deactivated;
    }

    await reportCatalogProgress(
      loaded,
      runId,
      stats,
      93,
      "Writing canonical catalog source",
    );
    await writeCanonicalCatalogSource(loaded, env);
    await reportCatalogProgress(
      loaded,
      runId,
      stats,
      96,
      "Refreshing catalog vector metadata",
    );
    await refreshSourceVectorizeIds(loaded.knowledgeSourceId);

    await finishCatalogRun(loaded, runId, "succeeded", stats, {
      rawR2Key,
      nextCursorAt,
      nextRunAt: computeNextCatalogRunAt(loaded, now),
    });

    await db
      .update(knowledgeSource)
      .set({
        status: "indexed",
        progress: 100,
        progressMessage: `Catalog sync complete: ${stats.created} created, ${stats.updated} updated, ${stats.deactivated} hidden`,
        parserErrors: [],
        updatedAt: new Date(),
      })
      .where(eq(knowledgeSource.id, loaded.knowledgeSourceId));

    return { runId, status: "succeeded", stats };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishCatalogRun(loaded, runId, "failed", stats, {
      error: message,
      nextRunAt: computeNextCatalogRunAt(loaded, now),
    });
    await db
      .update(knowledgeSource)
      .set({
        progressMessage: `Catalog sync failed: ${message}`,
        parserErrors: [message],
        updatedAt: new Date(),
      })
      .where(eq(knowledgeSource.id, loaded.knowledgeSourceId));
    throw error;
  }
}

export async function findCatalogExactMatches(options: {
  query: string;
  agentId: string;
  knowledgeSourceIds?: string[];
  limit?: number;
}): Promise<CatalogExactMatch[]> {
  const query = normalizeExactValue(options.query);
  if (!query) return [];

  const sourceFilter =
    options.knowledgeSourceIds && options.knowledgeSourceIds.length > 0
      ? inArray(catalogProduct.sourceId, options.knowledgeSourceIds)
      : undefined;

  const rows = await db
    .select({
      productId: catalogProduct.id,
      sourceId: catalogProduct.sourceId,
      recordKey: catalogProduct.recordKey,
      title: catalogProduct.title,
      data: catalogProduct.data,
      searchText: catalogProduct.searchText,
      exactMatchFields: catalogSyncConfig.exactMatchFields,
      stableKeyField: catalogSyncConfig.stableKeyField,
      titleField: catalogSyncConfig.titleField,
      fileName: knowledgeSource.fileName,
    })
    .from(catalogProduct)
    .innerJoin(
      catalogSyncConfig,
      eq(catalogSyncConfig.knowledgeSourceId, catalogProduct.sourceId),
    )
    .innerJoin(knowledgeSource, eq(knowledgeSource.id, catalogProduct.sourceId))
    .where(
      and(
        eq(catalogProduct.agentId, options.agentId),
        eq(catalogProduct.status, "active"),
        eq(catalogSyncConfig.enabled, true),
        eq(knowledgeSource.status, "indexed"),
        sourceFilter,
      ),
    )
    .limit(1000);

  const scoredProducts = rows
    .map((row) => {
      const fields = new Set([
        row.stableKeyField,
        row.titleField,
        ...(row.exactMatchFields ?? []),
      ]);
      const values = [
        row.recordKey,
        row.title ?? "",
        ...[...fields].map((field) =>
          stringifyScalar(getPathValue(row.data ?? {}, field)),
        ),
      ]
        .map(normalizeExactValue)
        .filter(Boolean);

      const exactHit = values.some((value) => value === query);
      const containsHit = values.some(
        (value) => value.includes(query) || query.includes(value),
      );
      const searchHit = normalizeExactValue(row.searchText ?? "").includes(
        query,
      );

      if (!exactHit && !containsHit && !searchHit) return null;

      return {
        productId: row.productId,
        sourceId: row.sourceId,
        recordKey: row.recordKey,
        title: row.title,
        fileName: row.fileName,
        score: exactHit ? 1.25 : containsHit ? 1.1 : 1,
      };
    })
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit ?? 5);

  if (scoredProducts.length === 0) return [];

  const productIds = scoredProducts.map((product) => product.productId);
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

  return scoredProducts.flatMap((product) => {
    const chunk = firstChunkByProduct.get(product.productId);
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
        catalogExactMatch: true,
      },
    };
  });
}

export async function countActiveCatalogProducts(options: {
  agentId: string;
  knowledgeSourceIds?: string[];
}): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(catalogProduct)
    .innerJoin(
      catalogSyncConfig,
      eq(catalogSyncConfig.knowledgeSourceId, catalogProduct.sourceId),
    )
    .innerJoin(knowledgeSource, eq(knowledgeSource.id, catalogProduct.sourceId))
    .where(buildActiveCatalogProductWhere(options));

  return Number(row?.total ?? 0);
}

export async function findCatalogStructuredQueryResult(options: {
  intent: CatalogStructuredIntent;
  agentId: string;
  knowledgeSourceIds?: string[];
  limit?: number;
}): Promise<CatalogStructuredQueryResult | null> {
  const totalActiveProducts = await countActiveCatalogProducts(options);
  if (totalActiveProducts === 0) return null;

  const productLimit =
    options.intent === "list"
      ? Math.max(1, Math.min(options.limit ?? 30, 50))
      : 0;
  const products =
    productLimit > 0
      ? await listActiveCatalogProducts({
          ...options,
          limit: productLimit,
        })
      : [];

  const content = buildCatalogStructuredContent({
    intent: options.intent,
    totalActiveProducts,
    products,
  });

  return {
    intent: options.intent,
    totalActiveProducts,
    returnedProducts: products.length,
    match: {
      id: `catalog-structured:${options.agentId}:${options.intent}`,
      score: 2,
      content,
      metadata: {
        catalogStructuredQuery: true,
        catalogStructuredIntent: options.intent,
        totalActiveProducts,
        productsReturned: products.length,
        sourceId: products[0]?.sourceId ?? `catalog:${options.agentId}`,
        fileName: "Catalog inventory",
      },
    },
  };
}

async function listActiveCatalogProducts(options: {
  agentId: string;
  knowledgeSourceIds?: string[];
  limit: number;
}): Promise<CatalogStructuredProductRow[]> {
  return db
    .select({
      productId: catalogProduct.id,
      sourceId: catalogProduct.sourceId,
      recordKey: catalogProduct.recordKey,
      title: catalogProduct.title,
      data: catalogProduct.data,
      exactMatchFields: catalogSyncConfig.exactMatchFields,
      fileName: knowledgeSource.fileName,
    })
    .from(catalogProduct)
    .innerJoin(
      catalogSyncConfig,
      eq(catalogSyncConfig.knowledgeSourceId, catalogProduct.sourceId),
    )
    .innerJoin(knowledgeSource, eq(knowledgeSource.id, catalogProduct.sourceId))
    .where(buildActiveCatalogProductWhere(options))
    .orderBy(asc(catalogProduct.title), asc(catalogProduct.recordKey))
    .limit(options.limit);
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
    eq(catalogSyncConfig.enabled, true),
    eq(knowledgeSource.status, "indexed"),
    sourceFilter,
  );
}

function buildCatalogStructuredContent(options: {
  intent: CatalogStructuredIntent;
  totalActiveProducts: number;
  products: CatalogStructuredProductRow[];
}): string {
  const lines = [
    "Catalog inventory summary (authoritative structured data from active catalog products).",
    `User inventory intent: ${options.intent}`,
    `Total active products: ${options.totalActiveProducts}`,
    `Products returned in this context: ${options.products.length}`,
  ];

  if (options.intent === "count") {
    lines.push(
      "Answer count questions using the exact total active products above.",
    );
    return lines.join("\n");
  }

  lines.push(
    "For broad product-list questions, list the products returned below. If products returned is less than total active products, say this is a partial list and invite the user to narrow by brand, category, product name, SKU, or barcode.",
    "",
    "Products:",
  );

  for (const [index, product] of options.products.entries()) {
    lines.push(`${index + 1}. ${formatCatalogStructuredProduct(product)}`);
  }

  return lines.join("\n");
}

function formatCatalogStructuredProduct(
  product: CatalogStructuredProductRow,
): string {
  const data = product.data ?? {};
  const facts = new Map<string, string>();

  facts.set("recordKey", product.recordKey);
  addCatalogFact(facts, "code", getPathValue(data, "code"));
  addCatalogFact(
    facts,
    "supplierSKU",
    getPathValue(data, "document.identity-codes.supplierSKU"),
  );
  addCatalogFact(
    facts,
    "gtin",
    getPathValue(data, "document.gs1-and-barcode.gtin"),
  );
  addCatalogFact(
    facts,
    "boxBarcode",
    getPathValue(data, "document.box-description.boxBarcode"),
  );
  addCatalogFact(
    facts,
    "brand",
    getPathValue(data, "parent.documentSummary.name.el-GR"),
  );
  addCatalogFact(facts, "category", getPathValue(data, "category"));

  for (const field of product.exactMatchFields ?? []) {
    addCatalogFact(facts, field, getPathValue(data, field));
  }

  const factText = [...facts.entries()]
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}: ${value}`)
    .join("; ");

  return `${product.title || product.recordKey}${factText ? ` (${factText})` : ""}`;
}

function addCatalogFact(
  facts: Map<string, string>,
  label: string,
  value: unknown,
): void {
  const stringValue = stringifyScalar(value);
  if (!stringValue || facts.has(label)) return;
  facts.set(label, stringValue);
}

async function loadCatalogSyncConfig(
  configId: string,
): Promise<CatalogSyncConfigRow | undefined> {
  const [row] = await db
    .select({
      id: catalogSyncConfig.id,
      agentId: catalogSyncConfig.agentId,
      knowledgeSourceId: catalogSyncConfig.knowledgeSourceId,
      experienceId: catalogSyncConfig.experienceId,
      name: catalogSyncConfig.name,
      enabled: catalogSyncConfig.enabled,
      snapshotUrl: catalogSyncConfig.snapshotUrl,
      diffUrl: catalogSyncConfig.diffUrl,
      authHeaderName: catalogSyncConfig.authHeaderName,
      authSecretName: catalogSyncConfig.authSecretName,
      updatedSinceParam: catalogSyncConfig.updatedSinceParam,
      itemPath: catalogSyncConfig.itemPath,
      stableKeyField: catalogSyncConfig.stableKeyField,
      updatedAtField: catalogSyncConfig.updatedAtField,
      deletionField: catalogSyncConfig.deletionField,
      deletionInactiveValues: catalogSyncConfig.deletionInactiveValues,
      titleField: catalogSyncConfig.titleField,
      searchableFields: catalogSyncConfig.searchableFields,
      exactMatchFields: catalogSyncConfig.exactMatchFields,
      syncIntervalDays: catalogSyncConfig.syncIntervalDays,
      scheduleWeekdayUtc: catalogSyncConfig.scheduleWeekdayUtc,
      scheduleHourUtc: catalogSyncConfig.scheduleHourUtc,
      nextRunAt: catalogSyncConfig.nextRunAt,
      cursorLastSuccessfulAt: catalogSyncConfig.cursorLastSuccessfulAt,
      lastCheckedAt: catalogSyncConfig.lastCheckedAt,
      lastSuccessfulSyncAt: catalogSyncConfig.lastSuccessfulSyncAt,
      lastRunId: catalogSyncConfig.lastRunId,
      lastRunStatus: catalogSyncConfig.lastRunStatus,
      lastRunError: catalogSyncConfig.lastRunError,
      createdAt: catalogSyncConfig.createdAt,
      updatedAt: catalogSyncConfig.updatedAt,
      sourceFileName: knowledgeSource.fileName,
      sourceR2Key: knowledgeSource.r2Key,
      sourceMime: knowledgeSource.mime,
      sourceStatus: knowledgeSource.status,
    })
    .from(catalogSyncConfig)
    .innerJoin(
      knowledgeSource,
      eq(knowledgeSource.id, catalogSyncConfig.knowledgeSourceId),
    )
    .where(eq(catalogSyncConfig.id, configId))
    .limit(1);

  return row;
}

async function fetchCatalogPayload(
  config: CatalogSyncConfigRow,
  env: Env,
  options: { mode: "diff" | "snapshot"; checkedSince: Date | null },
): Promise<{ payload: unknown; rawPayload: unknown; pagesFetched: number }> {
  const url = new URL(
    options.mode === "diff" ? config.diffUrl : config.snapshotUrl,
  );

  if (options.mode === "diff" && options.checkedSince) {
    url.searchParams.set(
      config.updatedSinceParam || "effectiveUpdatedAfter",
      options.checkedSince.toISOString(),
    );
  }

  const headers = new Headers({ Accept: "application/json" });
  const secretName = config.authSecretName?.trim();
  let authSecret: string | undefined;
  if (secretName) {
    const secret = (env as unknown as Record<string, unknown>)[secretName];
    if (typeof secret !== "string" || secret.length === 0) {
      throw new Error(`Catalog auth secret '${secretName}' is not configured`);
    }
    authSecret = secret.trim();
    headers.set(
      config.authHeaderName || "Authorization",
      formatCatalogAuthHeader(config.authHeaderName || "Authorization", secret),
    );
  }

  const firstPayload = await fetchCatalogPage(
    url,
    headers,
    options.mode,
    authSecret,
  );
  const pages = [firstPayload];
  const firstPageNumber = getNumericRecordValue(firstPayload, "page") ?? 1;
  const totalPages = getNumericRecordValue(firstPayload, "totalPages") ?? 1;

  if (totalPages > MAX_CATALOG_PAGES) {
    throw new Error(
      `Catalog API returned ${totalPages} pages; maximum supported is ${MAX_CATALOG_PAGES}`,
    );
  }

  for (let page = firstPageNumber + 1; page <= totalPages; page += 1) {
    const pageUrl = new URL(url);
    pageUrl.searchParams.set("page", String(page));
    pages.push(
      await fetchCatalogPage(pageUrl, headers, options.mode, authSecret),
    );
  }

  if (pages.length === 1) {
    return { payload: firstPayload, rawPayload: firstPayload, pagesFetched: 1 };
  }

  return {
    payload: combinePaginatedPayloads(pages, config.itemPath),
    rawPayload: {
      pages,
      pagination: {
        firstPage: firstPageNumber,
        pagesFetched: pages.length,
        totalPages,
      },
    },
    pagesFetched: pages.length,
  };
}

async function fetchCatalogPage(
  url: URL,
  headers: Headers,
  mode: "diff" | "snapshot",
  authSecret?: string,
): Promise<unknown> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = await response.text();
    const safeBody = authSecret ? redactCatalogSecret(body, authSecret) : body;
    throw new Error(
      `Catalog API ${mode} fetch failed: ${response.status} ${response.statusText}${safeBody ? ` - ${safeBody.slice(0, 500)}` : ""}`,
    );
  }

  return response.json();
}

function extractCatalogRecords(payload: unknown, itemPath: string): unknown[] {
  const target = itemPath ? getPathValue(payload, itemPath) : payload;
  if (!Array.isArray(target)) {
    throw new Error(
      itemPath
        ? `Catalog item path '${itemPath}' did not resolve to an array`
        : "Catalog payload must be an array or provide an item path",
    );
  }
  return target;
}

function combinePaginatedPayloads(pages: unknown[], itemPath: string): unknown {
  const records = pages.flatMap((page) =>
    extractCatalogRecords(page, itemPath),
  );
  if (!itemPath) return records;

  const combined = cloneJson(pages[0]);
  setPathValue(combined, itemPath, records);
  if (isRecord(combined)) {
    combined.totalResults = records.length;
    combined.page = 1;
    combined.totalPages = 1;
  }
  return combined;
}

function formatCatalogAuthHeader(headerName: string, secret: string): string {
  const trimmedSecret = secret.trim();
  if (
    headerName.trim().toLowerCase() === "authorization" &&
    !/^\S+\s+\S+/.test(trimmedSecret)
  ) {
    return `Bearer ${trimmedSecret}`;
  }
  return trimmedSecret;
}

function redactCatalogSecret(value: string, secret: string): string {
  const trimmedSecret = secret.trim();
  const values = [
    trimmedSecret,
    `Bearer ${trimmedSecret}`,
    formatCatalogAuthHeader("Authorization", trimmedSecret),
  ].filter((candidate) => candidate.length >= 4);

  return values.reduce(
    (text, candidate) => text.split(candidate).join("[redacted]"),
    value,
  );
}

async function normalizeCatalogRecord(
  config: CatalogSyncConfigRow,
  record: unknown,
): Promise<NormalizedProduct | null> {
  if (!isRecord(record)) return null;

  const recordKey = stringifyScalar(
    getPathValue(record, config.stableKeyField),
  );
  if (!recordKey) return null;

  const deletionValue = config.deletionField
    ? getPathValue(record, config.deletionField)
    : undefined;
  const active = !isInactiveCatalogValue(
    deletionValue,
    config.deletionInactiveValues ?? DEFAULT_INACTIVE_VALUES,
  );
  const title =
    stringifyScalar(getPathValue(record, config.titleField)) || recordKey;
  const data = record as Record<string, unknown>;
  const recordHash = await sha256(stableStringify(data));
  const searchText = buildCatalogSearchText(config, data, recordKey, title);
  const updatedAtValue = config.updatedAtField
    ? getPathValue(record, config.updatedAtField)
    : undefined;
  const updatedAt = parseCatalogDate(updatedAtValue);
  const id = `cat_${(await sha256(`${config.knowledgeSourceId}:${recordKey}`)).slice(0, 26)}`;

  return {
    id,
    recordKey,
    recordHash,
    title,
    searchText,
    data,
    active,
    updatedAt,
  };
}

function buildCatalogSearchText(
  config: CatalogSyncConfigRow,
  data: Record<string, unknown>,
  recordKey: string,
  title: string,
): string {
  const fields = new Set([
    config.stableKeyField,
    config.titleField,
    ...(config.exactMatchFields ?? []),
    ...(config.searchableFields ?? []),
  ]);
  const lines = [`Product: ${title}`, `Record key: ${recordKey}`];

  for (const field of fields) {
    const value = stringifyValue(getPathValue(data, field));
    if (value) lines.push(`${field}: ${value}`);
  }

  return lines.join("\n");
}

async function findCatalogProduct(
  sourceId: string,
  recordKey: string,
): Promise<CatalogProduct | undefined> {
  const [existing] = await db
    .select()
    .from(catalogProduct)
    .where(
      and(
        eq(catalogProduct.sourceId, sourceId),
        eq(catalogProduct.recordKey, recordKey),
      ),
    )
    .limit(1);

  return existing;
}

async function upsertCatalogProduct(
  config: CatalogSyncConfigRow,
  product: NormalizedProduct,
  existing?: CatalogProduct,
): Promise<CatalogProduct> {
  const now = new Date();

  if (existing) {
    await db
      .update(catalogProduct)
      .set({
        recordHash: product.recordHash,
        title: product.title,
        searchText: product.searchText,
        data: product.data,
        status: "active",
        lastSeenAt: now,
        deactivatedAt: null,
        updatedAt: now,
      })
      .where(eq(catalogProduct.id, existing.id));
  } else {
    await db.insert(catalogProduct).values({
      id: product.id,
      agentId: config.agentId,
      sourceId: config.knowledgeSourceId,
      recordKey: product.recordKey,
      recordHash: product.recordHash,
      title: product.title,
      searchText: product.searchText,
      data: product.data,
      status: "active",
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }

  const [row] = await db
    .select()
    .from(catalogProduct)
    .where(eq(catalogProduct.id, existing?.id ?? product.id))
    .limit(1);

  if (!row) throw new Error(`Catalog product ${product.recordKey} not found`);
  return row;
}

async function deactivateCatalogProduct(
  config: CatalogSyncConfigRow,
  recordKey: string,
  env: Env,
): Promise<boolean> {
  const existing = await findCatalogProduct(
    config.knowledgeSourceId,
    recordKey,
  );
  if (!existing || existing.status === "inactive") return false;

  await cleanupProductChunks(existing.id, config.agentId, env);
  await db
    .update(catalogProduct)
    .set({
      status: "inactive",
      deactivatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(catalogProduct.id, existing.id));
  return true;
}

async function deactivateMissingSnapshotProducts(
  config: CatalogSyncConfigRow,
  seenRecordKeys: Set<string>,
  env: Env,
): Promise<number> {
  const activeProducts = await db
    .select()
    .from(catalogProduct)
    .where(
      and(
        eq(catalogProduct.sourceId, config.knowledgeSourceId),
        eq(catalogProduct.status, "active"),
      ),
    );

  let deactivated = 0;
  for (const product of activeProducts) {
    if (seenRecordKeys.has(product.recordKey)) continue;
    await cleanupProductChunks(product.id, config.agentId, env);
    await db
      .update(catalogProduct)
      .set({
        status: "inactive",
        deactivatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(catalogProduct.id, product.id));
    deactivated += 1;
  }

  return deactivated;
}

async function replaceCatalogProductChunks(
  config: CatalogSyncConfigRow,
  product: CatalogProduct,
  env: Env,
): Promise<{ chunksInserted: number; vectorsUpserted: number }> {
  await cleanupProductChunks(product.id, config.agentId, env);

  const chunks = await buildProductChunks(config, product);
  if (chunks.length === 0) {
    return { chunksInserted: 0, vectorsUpserted: 0 };
  }

  const embeddings = await generateEmbeddings(
    chunks.map((chunk) => chunk.text),
  );
  const now = new Date();
  const insertedIds: string[] = [];

  try {
    for (const chunk of chunks) {
      await db.insert(documentChunks).values({
        id: chunk.id,
        text: chunk.text,
        sessionId: config.agentId,
        documentId: config.knowledgeSourceId,
        chunkIndex: chunk.chunkIndex,
        vectorizeId: chunk.id,
        productId: product.id,
        recordKey: product.recordKey,
        recordHash: product.recordHash,
        metadata: {
          catalogProduct: true,
          productId: product.id,
          recordKey: product.recordKey,
          title: product.title,
        },
        createdAt: now,
      });
      insertedIds.push(chunk.id);
    }

    for (let i = 0; i < chunks.length; i += CATALOG_VECTOR_BATCH_SIZE) {
      const batch = chunks.slice(i, i + CATALOG_VECTOR_BATCH_SIZE);
      await env.VECTORIZE.upsert(
        batch.map((chunk, batchIndex) => {
          const embeddingIndex = i + batchIndex;
          return {
            id: chunk.id,
            values: embeddings[embeddingIndex],
            namespace: config.agentId,
            metadata: {
              sourceId: config.knowledgeSourceId,
              chunkId: chunk.id,
              fileName: config.sourceFileName || config.name,
              productId: product.id,
              recordKey: product.recordKey,
            },
          };
        }),
      );
    }
  } catch (error) {
    if (insertedIds.length > 0) {
      await db
        .delete(documentChunks)
        .where(inArray(documentChunks.id, insertedIds));
    }
    throw error;
  }

  return {
    chunksInserted: chunks.length,
    vectorsUpserted: chunks.length,
  };
}

async function buildProductChunks(
  config: CatalogSyncConfigRow,
  product: CatalogProduct,
): Promise<ProductChunk[]> {
  const data = product.data ?? {};
  const fields = new Set([
    config.stableKeyField,
    config.titleField,
    ...(config.exactMatchFields ?? []),
    ...(config.searchableFields ?? []),
  ]);

  const lines = [
    `Product: ${product.title ?? product.recordKey}`,
    `Record key: ${product.recordKey}`,
  ];

  for (const field of fields) {
    const value = stringifyValue(getPathValue(data, field));
    if (value) lines.push(`${field}: ${value}`);
  }

  const baseText = lines.join("\n");
  const maxBodyLength = Math.max(600, CHUNKING_CONFIG.CHUNK_SIZE * 2);
  const chunks: string[] = [];

  if (baseText.length <= maxBodyLength) {
    chunks.push(baseText);
  } else {
    let cursor = 0;
    const header = `Product: ${product.title ?? product.recordKey}\nRecord key: ${product.recordKey}`;
    while (cursor < baseText.length) {
      chunks.push(
        `${header}\n${baseText.slice(cursor, cursor + maxBodyLength)}`,
      );
      cursor += maxBodyLength;
    }
  }

  const nextChunkIndex = await getNextSourceChunkIndex(
    config.knowledgeSourceId,
  );
  return chunks.map((text, index) => ({
    id: `catalog:${product.id}:${index}`,
    text,
    chunkIndex: nextChunkIndex + index,
  }));
}

async function cleanupProductChunks(
  productId: string,
  agentId: string,
  env: Env,
): Promise<void> {
  const existingChunks = await db
    .select({ id: documentChunks.id, vectorizeId: documentChunks.vectorizeId })
    .from(documentChunks)
    .where(eq(documentChunks.productId, productId));

  const vectorIds = existingChunks
    .map((chunk) => chunk.vectorizeId ?? chunk.id)
    .filter(Boolean);
  if (vectorIds.length > 0) {
    try {
      await deleteVectorizeIds(env.VECTORIZE, vectorIds, {
        namespace: agentId,
        logPrefix: "Catalog Vectorize",
      });
    } catch (error) {
      console.error(
        `[Catalog Sync] Failed deleting vectors for product ${productId}; continuing D1 cleanup`,
        error,
      );
    }
  }

  await db
    .delete(documentChunks)
    .where(eq(documentChunks.productId, productId));
}

async function getNextSourceChunkIndex(sourceId: string): Promise<number> {
  const [row] = await db
    .select({
      maxChunkIndex: sql<number>`coalesce(max(${documentChunks.chunkIndex}), -1)`,
    })
    .from(documentChunks)
    .where(eq(documentChunks.documentId, sourceId));

  return Number(row?.maxChunkIndex ?? -1) + 1;
}

async function writeCanonicalCatalogSource(
  config: CatalogSyncConfigRow,
  env: Env,
): Promise<void> {
  if (!config.sourceR2Key) return;

  const activeProducts = await db
    .select({
      recordKey: catalogProduct.recordKey,
      title: catalogProduct.title,
      data: catalogProduct.data,
    })
    .from(catalogProduct)
    .where(
      and(
        eq(catalogProduct.sourceId, config.knowledgeSourceId),
        eq(catalogProduct.status, "active"),
      ),
    )
    .orderBy(asc(catalogProduct.recordKey));

  const content = activeProducts
    .map((product) =>
      JSON.stringify({
        recordKey: product.recordKey,
        title: product.title,
        ...product.data,
      }),
    )
    .join("\n");

  await env.R2.put(config.sourceR2Key, content, {
    httpMetadata: { contentType: "application/x-ndjson; charset=utf-8" },
  });

  await db
    .update(knowledgeSource)
    .set({
      bytes: new TextEncoder().encode(content).byteLength,
      mime: "application/x-ndjson",
      updatedAt: new Date(),
    })
    .where(eq(knowledgeSource.id, config.knowledgeSourceId));
}

async function refreshSourceVectorizeIds(sourceId: string): Promise<void> {
  const rows = await db
    .select({ vectorizeId: documentChunks.vectorizeId })
    .from(documentChunks)
    .where(eq(documentChunks.documentId, sourceId));

  await db
    .update(knowledgeSource)
    .set({
      vectorizeIds: rows
        .map((row) => row.vectorizeId)
        .filter((id): id is string => Boolean(id)),
      updatedAt: new Date(),
    })
    .where(eq(knowledgeSource.id, sourceId));
}

async function finishCatalogRun(
  config: CatalogSyncConfigRow,
  runId: string,
  status: CatalogRunStatus,
  stats: CatalogSyncStats,
  options: {
    rawR2Key?: string;
    nextCursorAt?: Date;
    nextRunAt?: Date;
    error?: string;
  },
): Promise<void> {
  const completedAt = new Date();

  await db
    .update(catalogSyncRun)
    .set({
      status,
      stats: stats as unknown as Record<string, unknown>,
      rawR2Key: options.rawR2Key,
      nextCursorAt: options.nextCursorAt,
      error: options.error,
      completedAt,
      updatedAt: completedAt,
    })
    .where(eq(catalogSyncRun.id, runId));

  await db
    .update(catalogSyncConfig)
    .set({
      lastRunStatus: status,
      lastRunError: options.error ?? null,
      lastCheckedAt: completedAt,
      lastSuccessfulSyncAt: status === "succeeded" ? completedAt : undefined,
      cursorLastSuccessfulAt:
        status === "succeeded"
          ? (options.nextCursorAt ?? completedAt)
          : config.cursorLastSuccessfulAt,
      nextRunAt: options.nextRunAt,
      updatedAt: completedAt,
    })
    .where(eq(catalogSyncConfig.id, config.id));
}

async function reportCatalogProgress(
  config: CatalogSyncConfigRow,
  runId: string,
  stats: CatalogSyncStats,
  progress: number,
  progressMessage: string,
  options: { rawR2Key?: string } = {},
): Promise<void> {
  const updatedAt = new Date();
  const boundedProgress = Math.min(99, Math.max(0, Math.round(progress)));
  const runValues: Partial<typeof catalogSyncRun.$inferInsert> = {
    stats: stats as unknown as Record<string, unknown>,
    updatedAt,
  };

  if (options.rawR2Key) {
    runValues.rawR2Key = options.rawR2Key;
  }

  await db
    .update(knowledgeSource)
    .set({
      status: "processing",
      progress: boundedProgress,
      progressMessage,
      parserErrors: [],
      updatedAt,
    })
    .where(eq(knowledgeSource.id, config.knowledgeSourceId));

  await db
    .update(catalogSyncRun)
    .set(runValues)
    .where(eq(catalogSyncRun.id, runId));
}

function getCatalogIndexProgress(processed: number, total: number): number {
  if (total <= 0) return CATALOG_PROGRESS_INDEX_END;

  const ratio = Math.min(1, Math.max(0, processed / total));
  return (
    CATALOG_PROGRESS_INDEX_START +
    ratio * (CATALOG_PROGRESS_INDEX_END - CATALOG_PROGRESS_INDEX_START)
  );
}

function formatCatalogIndexProgressMessage(
  processed: number,
  total: number,
  stats: CatalogSyncStats,
): string {
  if (total <= 0) {
    return "No catalog products returned; finalizing catalog";
  }

  return `Indexing catalog products ${processed}/${total}: ${stats.created} created, ${stats.updated} updated, ${stats.unchanged} unchanged, ${stats.deactivated} hidden, ${stats.chunksInserted} chunks`;
}

function emptyStats(): CatalogSyncStats {
  return {
    fetched: 0,
    pagesFetched: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    deactivated: 0,
    skipped: 0,
    chunksInserted: 0,
    vectorsUpserted: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPathValue(value: unknown, path: string): unknown {
  if (!path) return value;

  return path.split(".").reduce<unknown>((current, segment) => {
    if (current == null || !segment) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      return Number.isInteger(index) ? current[index] : undefined;
    }
    if (typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function setPathValue(value: unknown, path: string, nextValue: unknown): void {
  if (!path || !isRecord(value)) return;

  const segments = path.split(".").filter(Boolean);
  let current: Record<string, unknown> = value;

  for (const [index, segment] of segments.entries()) {
    if (index === segments.length - 1) {
      current[segment] = nextValue;
      return;
    }

    const child = current[segment];
    if (!isRecord(child)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
}

function getNumericRecordValue(
  value: unknown,
  key: string,
): number | undefined {
  if (!isRecord(value)) return undefined;

  const candidate = value[key];
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    return Math.trunc(candidate);
  }
  if (typeof candidate === "string" && candidate.trim()) {
    const parsed = Number(candidate);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
  }
  return undefined;
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function stringifyScalar(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function stringifyValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(stringifyValue).filter(Boolean).join(", ");
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return "";
}

function normalizeExactValue(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function isInactiveCatalogValue(
  value: unknown,
  inactiveValues: string[],
): boolean {
  if (value == null) return false;
  const normalized = normalizeExactValue(String(value));
  return inactiveValues.map(normalizeExactValue).includes(normalized);
}

function parseCatalogDate(value: unknown): Date | undefined {
  if (value == null || value === "") return undefined;
  const date =
    typeof value === "number" ? new Date(value) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

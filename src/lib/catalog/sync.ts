import { and, eq, isNull, lte, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/db";
import {
  type CatalogSyncConfig,
  catalogConfig,
  catalogProduct,
  catalogSyncConfig,
  catalogSyncRun,
  knowledgeSource,
} from "@/db/schema";
import {
  applyCatalogRecords,
  type CatalogImportStats,
  type CatalogIndexBuild,
  emptyCatalogImportStats,
  failCatalogIndexVersion,
  prepareCatalogIndexVersion,
  promoteCatalogIndexVersion,
  refreshSourceVectorizeIds as refreshSharedSourceVectorizeIds,
  writeCanonicalCatalogSource as writeSharedCanonicalCatalogSource,
} from "./apply";
import { loadCatalogImportConfigById } from "./config";
import { type CatalogImportConfig, getPathValue, isRecord } from "./shared";

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

export type CatalogSyncStats = CatalogImportStats;

type CatalogSyncConfigRow = CatalogSyncConfig & {
  sourceFileName: string | null;
  sourceR2Key: string | null;
  sourceMime: string | null;
  sourceStatus: string;
  catalogOrigin: "api" | "csv" | null;
  catalogEnabled: boolean | null;
  catalogScopeName: string | null;
  catalogScopeAliases: string[] | null;
  catalogStableKeyField: string | null;
  catalogUpdatedAtField: string | null;
  catalogDeletionField: string | null;
  catalogDeletionInactiveValues: string[] | null;
  catalogTitleField: string | null;
  catalogSearchableFields: string[] | null;
  catalogExactMatchFields: string[] | null;
  catalogFilterableFields: string[] | null;
};

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
  let indexBuild: CatalogIndexBuild | undefined;
  let importConfig: CatalogImportConfig | undefined;

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

    let processedRecords = 0;
    let lastProgressReportAt = 0;
    importConfig = loaded.catalogConfigId
      ? ((await loadCatalogImportConfigById(loaded.catalogConfigId)) ??
        toCatalogImportConfig(loaded))
      : toCatalogImportConfig(loaded);
    if (!importConfig) {
      throw new Error(`Catalog import config not found for ${loaded.id}`);
    }
    indexBuild = await prepareCatalogIndexVersion({
      config: importConfig,
      runId,
    });

    const maybeReportIndexProgress = async (
      processed: number,
      total: number,
      force = false,
    ) => {
      const nowMs = Date.now();
      if (
        !force &&
        processed < total &&
        processed % 10 !== 0 &&
        nowMs - lastProgressReportAt < 5000
      ) {
        return;
      }

      lastProgressReportAt = nowMs;
      await reportCatalogProgress(
        loaded,
        runId,
        stats,
        getCatalogIndexProgress(processed, total),
        formatCatalogIndexProgressMessage(processed, total, stats),
      );
    };

    await maybeReportIndexProgress(0, records.length, true);
    const applyResult = await applyCatalogRecords({
      config: importConfig,
      records,
      env,
      mode: resolvedMode,
      indexVersion: indexBuild.version,
      cursorBase: checkedSince ?? now,
      stats,
      onProgress: async ({ processed, total }) => {
        processedRecords = processed;
        await maybeReportIndexProgress(processed, total);
      },
    });
    await maybeReportIndexProgress(processedRecords, records.length, true);

    await reportCatalogProgress(
      loaded,
      runId,
      stats,
      93,
      "Writing canonical catalog source",
    );
    await writeSharedCanonicalCatalogSource(importConfig, env, {
      indexVersion: indexBuild.version,
    });
    await reportCatalogProgress(
      loaded,
      runId,
      stats,
      96,
      "Refreshing catalog vector metadata",
    );
    await refreshSharedSourceVectorizeIds(loaded.knowledgeSourceId, {
      indexVersion: indexBuild.version,
    });
    await promoteCatalogIndexVersion({
      config: importConfig,
      build: indexBuild,
      env,
      stats,
    });

    await finishCatalogRun(loaded, runId, "succeeded", stats, {
      rawR2Key,
      nextCursorAt: applyResult.nextCursorAt,
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
    await failCatalogIndexVersion({ build: indexBuild, error, stats });
    const message = error instanceof Error ? error.message : String(error);
    const hasActiveCatalog = await hasActiveCatalogProducts(
      loaded.knowledgeSourceId,
    );
    const sourceUpdate: Partial<typeof knowledgeSource.$inferInsert> = {
      status: hasActiveCatalog ? "indexed" : "failed",
      progressMessage: `Catalog sync failed: ${message}`,
      parserErrors: [message],
      updatedAt: new Date(),
    };
    if (hasActiveCatalog || loaded.sourceStatus === "indexed") {
      sourceUpdate.progress = 100;
    }
    await finishCatalogRun(loaded, runId, "failed", stats, {
      error: message,
      nextRunAt: computeNextCatalogRunAt(loaded, now),
    });
    await db
      .update(knowledgeSource)
      .set(sourceUpdate)
      .where(eq(knowledgeSource.id, loaded.knowledgeSourceId));
    throw error;
  }
}

async function hasActiveCatalogProducts(sourceId: string): Promise<boolean> {
  const [activeConfig] = await db
    .select({ activeIndexVersion: catalogConfig.activeIndexVersion })
    .from(catalogConfig)
    .where(eq(catalogConfig.knowledgeSourceId, sourceId))
    .limit(1);

  if (!activeConfig) return false;

  const [product] = await db
    .select({ id: catalogProduct.id })
    .from(catalogProduct)
    .where(
      and(
        eq(catalogProduct.sourceId, sourceId),
        eq(catalogProduct.indexVersion, activeConfig.activeIndexVersion),
        eq(catalogProduct.status, "active"),
      ),
    )
    .limit(1);

  return Boolean(product);
}

async function loadCatalogSyncConfig(
  configId: string,
): Promise<CatalogSyncConfigRow | undefined> {
  const [row] = await db
    .select({
      id: catalogSyncConfig.id,
      catalogConfigId: catalogSyncConfig.catalogConfigId,
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
      catalogOrigin: catalogConfig.origin,
      catalogEnabled: catalogConfig.enabled,
      catalogScopeName: catalogConfig.scopeName,
      catalogScopeAliases: catalogConfig.scopeAliases,
      catalogStableKeyField: catalogConfig.stableKeyField,
      catalogUpdatedAtField: catalogConfig.updatedAtField,
      catalogDeletionField: catalogConfig.deletionField,
      catalogDeletionInactiveValues: catalogConfig.deletionInactiveValues,
      catalogTitleField: catalogConfig.titleField,
      catalogSearchableFields: catalogConfig.searchableFields,
      catalogExactMatchFields: catalogConfig.exactMatchFields,
      catalogFilterableFields: catalogConfig.filterableFields,
    })
    .from(catalogSyncConfig)
    .innerJoin(
      knowledgeSource,
      eq(knowledgeSource.id, catalogSyncConfig.knowledgeSourceId),
    )
    .leftJoin(
      catalogConfig,
      eq(catalogConfig.id, catalogSyncConfig.catalogConfigId),
    )
    .where(eq(catalogSyncConfig.id, configId))
    .limit(1);

  return row;
}

function toCatalogImportConfig(
  config: CatalogSyncConfigRow,
): CatalogImportConfig {
  return {
    id: config.catalogConfigId ?? config.id,
    agentId: config.agentId,
    knowledgeSourceId: config.knowledgeSourceId,
    name: config.name,
    scopeName: config.catalogScopeName,
    scopeAliases: config.catalogScopeAliases,
    origin: config.catalogOrigin ?? "api",
    enabled: config.catalogEnabled ?? config.enabled,
    stableKeyField: config.catalogStableKeyField ?? config.stableKeyField,
    updatedAtField: config.catalogUpdatedAtField ?? config.updatedAtField,
    deletionField: config.catalogDeletionField ?? config.deletionField,
    deletionInactiveValues:
      config.catalogDeletionInactiveValues ?? config.deletionInactiveValues,
    titleField: config.catalogTitleField ?? config.titleField,
    searchableFields:
      config.catalogSearchableFields ?? config.searchableFields ?? [],
    exactMatchFields:
      config.catalogExactMatchFields ?? config.exactMatchFields ?? [],
    filterableFields: config.catalogFilterableFields ?? [],
    sourceFileName: config.sourceFileName,
    sourceR2Key: config.sourceR2Key,
  };
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
  return emptyCatalogImportStats();
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

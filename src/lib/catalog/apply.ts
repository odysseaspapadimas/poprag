import { and, asc, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { db } from "@/db";
import {
  type CatalogProduct,
  catalogConfig,
  catalogIndexVersion,
  catalogProduct,
  catalogProductFact,
  documentChunks,
  knowledgeSource,
} from "@/db/schema";
import { CHUNKING_CONFIG, EMBEDDING_CONFIG } from "@/lib/ai/constants";
import { generateEmbeddings } from "@/lib/ai/embedding";
import { deleteVectorizeIds } from "@/lib/ai/ingestion";
import {
  type CatalogFieldFactInput,
  type CatalogImportConfig,
  collectCatalogFacts,
  getPathValue,
  makeCatalogFactId,
  makeCatalogProductId,
  type NormalizedCatalogProduct,
  normalizeCatalogFactValue,
  normalizeCatalogRecord,
  stringifyValue,
  uniqueFieldList,
} from "./shared";

export interface CatalogImportStats {
  fetched: number;
  pagesFetched: number;
  created: number;
  updated: number;
  unchanged: number;
  deactivated: number;
  skipped: number;
  chunksInserted: number;
  vectorsUpserted: number;
  factsInserted: number;
}

export interface CatalogApplyProgress {
  phase: "normalize" | "index";
  processed: number;
  total: number;
  stats: CatalogImportStats;
}

export interface CatalogApplyResult {
  stats: CatalogImportStats;
  seenRecordKeys: Set<string>;
  nextCursorAt?: Date;
}

export interface CatalogIndexBuild {
  id: string;
  version: number;
  previousVersion: number;
}

type ProductChunk = {
  id: string;
  text: string;
  chunkIndex: number;
};

const CATALOG_VECTOR_BATCH_SIZE = 20;

export function emptyCatalogImportStats(): CatalogImportStats {
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
    factsInserted: 0,
  };
}

export async function prepareCatalogIndexVersion(options: {
  config: CatalogImportConfig;
  runId?: string;
}): Promise<CatalogIndexBuild> {
  const [configRow] = await db
    .select({
      id: catalogConfig.id,
      activeIndexVersion: catalogConfig.activeIndexVersion,
    })
    .from(catalogConfig)
    .where(eq(catalogConfig.id, options.config.id))
    .limit(1);

  if (!configRow) {
    throw new Error(`Catalog config ${options.config.id} not found`);
  }

  const [latest] = await db
    .select({ version: catalogIndexVersion.version })
    .from(catalogIndexVersion)
    .where(eq(catalogIndexVersion.sourceId, options.config.knowledgeSourceId))
    .orderBy(desc(catalogIndexVersion.version))
    .limit(1);

  const previousVersion = configRow.activeIndexVersion ?? 0;
  const version = Math.max(previousVersion, latest?.version ?? 0) + 1;
  const id = `catidx_${options.config.knowledgeSourceId}_${version}`;
  const now = new Date();

  await db.insert(catalogIndexVersion).values({
    id,
    agentId: options.config.agentId,
    sourceId: options.config.knowledgeSourceId,
    catalogConfigId: options.config.id,
    runId: options.runId,
    version,
    status: "building",
    createdAt: now,
    updatedAt: now,
  });

  return { id, version, previousVersion };
}

export async function promoteCatalogIndexVersion(options: {
  config: CatalogImportConfig;
  build: CatalogIndexBuild;
  env: Env;
  stats: CatalogImportStats;
  catalogConfigUpdates?: Partial<typeof catalogConfig.$inferInsert>;
}): Promise<void> {
  const promotedAt = new Date();

  await db
    .update(catalogIndexVersion)
    .set({
      status: "active",
      stats: options.stats as unknown as Record<string, unknown>,
      promotedAt,
      updatedAt: promotedAt,
    })
    .where(eq(catalogIndexVersion.id, options.build.id));

  await db
    .update(catalogIndexVersion)
    .set({ status: "superseded", updatedAt: promotedAt })
    .where(
      and(
        eq(catalogIndexVersion.sourceId, options.config.knowledgeSourceId),
        ne(catalogIndexVersion.id, options.build.id),
        eq(catalogIndexVersion.status, "active"),
      ),
    );

  await db
    .update(catalogConfig)
    .set({
      ...(options.catalogConfigUpdates ?? {}),
      activeIndexVersion: options.build.version,
      updatedAt: promotedAt,
    })
    .where(eq(catalogConfig.id, options.config.id));

  try {
    await cleanupSupersededCatalogVersions({
      config: options.config,
      activeVersion: options.build.version,
      env: options.env,
    });
  } catch (error) {
    console.error(
      `[Catalog] Failed cleaning superseded versions for source ${options.config.knowledgeSourceId}; active index version remains ${options.build.version}`,
      error,
    );
  }
}

export async function failCatalogIndexVersion(options: {
  build?: CatalogIndexBuild;
  error: unknown;
  stats?: CatalogImportStats;
}): Promise<void> {
  if (!options.build) return;
  const message =
    options.error instanceof Error
      ? options.error.message
      : String(options.error);
  await db
    .update(catalogIndexVersion)
    .set({
      status: "failed",
      error: message,
      stats: options.stats as unknown as Record<string, unknown>,
      updatedAt: new Date(),
    })
    .where(eq(catalogIndexVersion.id, options.build.id));
}

export async function applyCatalogRecords(options: {
  config: CatalogImportConfig;
  records: unknown[];
  env: Env;
  mode: "diff" | "snapshot";
  indexVersion?: number;
  cursorBase?: Date | null;
  stats?: CatalogImportStats;
  onProgress?: (state: CatalogApplyProgress) => Promise<void>;
}): Promise<CatalogApplyResult> {
  const now = new Date();
  const stats = options.stats ?? emptyCatalogImportStats();
  const seenRecordKeys = new Set<string>();
  let nextCursorAt = options.cursorBase ?? now;
  let processed = 0;
  const normalizedRecords: NormalizedCatalogProduct[] = [];

  for (const record of options.records) {
    try {
      const normalized = await normalizeCatalogRecord(options.config, record);
      if (!normalized) {
        stats.skipped += 1;
        continue;
      }

      seenRecordKeys.add(normalized.recordKey);
      if (normalized.updatedAt && normalized.updatedAt > nextCursorAt) {
        nextCursorAt = normalized.updatedAt;
      }

      normalizedRecords.push(normalized);
    } finally {
      processed += 1;
      await options.onProgress?.({
        phase: "normalize",
        processed,
        total: options.records.length,
        stats,
      });
    }
  }

  if (options.indexVersion === undefined) {
    throw new Error(
      "Catalog indexing requires an explicit indexVersion. Call prepareCatalogIndexVersion before applyCatalogRecords.",
    );
  }

  const products = await materializeCatalogVersionProducts({
    config: options.config,
    mode: options.mode,
    indexVersion: options.indexVersion,
    normalizedRecords,
    seenRecordKeys,
    stats,
  });

  processed = 0;
  for (const product of products) {
    const inserted = await insertCatalogProductVersion(
      options.config,
      product,
      options.indexVersion,
    );
    const factResult = await replaceCatalogProductFacts(
      options.config,
      inserted,
    );
    const indexingResult = await replaceCatalogProductChunks(
      options.config,
      inserted,
      options.env,
    );

    stats.factsInserted += factResult.factsInserted;
    stats.chunksInserted += indexingResult.chunksInserted;
    stats.vectorsUpserted += indexingResult.vectorsUpserted;

    processed += 1;
    await options.onProgress?.({
      phase: "index",
      processed,
      total: products.length,
      stats,
    });
  }

  return { stats, seenRecordKeys, nextCursorAt };
}

export async function materializeCatalogVersionProducts(options: {
  config: CatalogImportConfig;
  mode: "diff" | "snapshot";
  indexVersion: number;
  normalizedRecords: NormalizedCatalogProduct[];
  seenRecordKeys: Set<string>;
  stats: CatalogImportStats;
}): Promise<NormalizedCatalogProduct[]> {
  const previousProducts = await loadActiveCatalogProducts(options.config);
  const previousByKey = new Map(
    previousProducts.map((product) => [product.recordKey, product]),
  );
  const nextByKey = new Map<string, NormalizedCatalogProduct>();

  if (options.mode === "diff") {
    for (const product of previousProducts) {
      nextByKey.set(product.recordKey, {
        id: await makeCatalogProductId(
          options.config.knowledgeSourceId,
          product.recordKey,
          options.indexVersion,
        ),
        recordKey: product.recordKey,
        recordHash: product.recordHash,
        title: product.title ?? product.recordKey,
        searchText:
          product.searchText ??
          stringifyValue({
            recordKey: product.recordKey,
            title: product.title,
            ...product.data,
          }),
        data: product.data ?? {},
        active: product.status === "active",
        updatedAt: product.updatedAt,
      });
    }
  }

  for (const normalized of options.normalizedRecords) {
    const previous = previousByKey.get(normalized.recordKey);
    if (!normalized.active) {
      if (previous?.status === "active") options.stats.deactivated += 1;
      nextByKey.delete(normalized.recordKey);
      continue;
    }

    const versionedProduct = {
      ...normalized,
      id: await makeCatalogProductId(
        options.config.knowledgeSourceId,
        normalized.recordKey,
        options.indexVersion,
      ),
    };
    nextByKey.set(normalized.recordKey, versionedProduct);

    if (!previous) {
      options.stats.created += 1;
    } else if (previous.recordHash === normalized.recordHash) {
      options.stats.unchanged += 1;
    } else {
      options.stats.updated += 1;
    }
  }

  if (options.mode === "snapshot") {
    for (const previous of previousProducts) {
      if (!options.seenRecordKeys.has(previous.recordKey)) {
        options.stats.deactivated += 1;
      }
    }
  }

  return [...nextByKey.values()].filter((product) => product.active);
}

async function loadActiveCatalogProducts(
  config: CatalogImportConfig,
): Promise<CatalogProduct[]> {
  const activeIndexVersion = await getActiveCatalogIndexVersion(config);

  return db
    .select()
    .from(catalogProduct)
    .where(
      and(
        eq(catalogProduct.sourceId, config.knowledgeSourceId),
        eq(catalogProduct.indexVersion, activeIndexVersion),
        eq(catalogProduct.status, "active"),
      ),
    );
}

async function getActiveCatalogIndexVersion(
  config: CatalogImportConfig,
): Promise<number> {
  const [configRow] = await db
    .select({ activeIndexVersion: catalogConfig.activeIndexVersion })
    .from(catalogConfig)
    .where(eq(catalogConfig.id, config.id))
    .limit(1);
  return configRow?.activeIndexVersion ?? 0;
}

export async function rebuildCatalogFactsForSource(options: {
  config: CatalogImportConfig;
}): Promise<{ productsProcessed: number; factsInserted: number }> {
  const activeIndexVersion = await getActiveCatalogIndexVersion(options.config);
  const products = await db
    .select()
    .from(catalogProduct)
    .where(
      and(
        eq(catalogProduct.sourceId, options.config.knowledgeSourceId),
        eq(catalogProduct.indexVersion, activeIndexVersion),
        eq(catalogProduct.status, "active"),
      ),
    );

  let factsInserted = 0;
  for (const product of products) {
    const result = await replaceCatalogProductFacts(options.config, product);
    factsInserted += result.factsInserted;
  }

  return { productsProcessed: products.length, factsInserted };
}

export async function rebuildCatalogIndexFromActiveProducts(options: {
  config: CatalogImportConfig;
  env: Env;
  runId?: string;
  catalogConfigUpdates?: Partial<typeof catalogConfig.$inferInsert>;
  onProgress?: (state: CatalogApplyProgress) => Promise<void>;
}): Promise<{ build: CatalogIndexBuild; stats: CatalogImportStats }> {
  const stats = emptyCatalogImportStats();
  const activeProducts = await loadActiveCatalogProducts(options.config);
  const records = activeProducts.map(
    (product) =>
      product.data ?? {
        [options.config.stableKeyField]: product.recordKey,
        [options.config.titleField]: product.title ?? product.recordKey,
      },
  );
  stats.fetched = records.length;
  stats.pagesFetched = records.length > 0 ? 1 : 0;

  let build: CatalogIndexBuild | undefined;
  try {
    build = await prepareCatalogIndexVersion({
      config: options.config,
      runId: options.runId,
    });
    await applyCatalogRecords({
      config: options.config,
      records,
      env: options.env,
      mode: "snapshot",
      indexVersion: build.version,
      stats,
      onProgress: options.onProgress,
    });

    if (records.length > 0 && stats.skipped === records.length) {
      throw new Error(
        `Catalog mapping rebuild skipped every active product for source ${options.config.knowledgeSourceId}; verify the stable key field before saving this mapping.`,
      );
    }

    await writeCanonicalCatalogSource(options.config, options.env, {
      indexVersion: build.version,
    });
    await refreshSourceVectorizeIds(options.config.knowledgeSourceId, {
      indexVersion: build.version,
    });
    await promoteCatalogIndexVersion({
      config: options.config,
      build,
      env: options.env,
      stats,
      catalogConfigUpdates: options.catalogConfigUpdates,
    });

    return { build, stats };
  } catch (error) {
    await failCatalogIndexVersion({ build, error, stats });
    throw error;
  }
}

export async function refreshSourceVectorizeIds(
  sourceId: string,
  options?: { indexVersion?: number },
): Promise<void> {
  const [config] = await db
    .select({ activeIndexVersion: catalogConfig.activeIndexVersion })
    .from(catalogConfig)
    .where(eq(catalogConfig.knowledgeSourceId, sourceId))
    .limit(1);
  const activeVersion =
    options?.indexVersion ?? config?.activeIndexVersion ?? 0;
  const rows = await db
    .select({ vectorizeId: documentChunks.vectorizeId })
    .from(documentChunks)
    .where(
      and(
        eq(documentChunks.documentId, sourceId),
        activeVersion > 0
          ? eq(documentChunks.catalogIndexVersion, activeVersion)
          : or(
              isNull(documentChunks.catalogIndexVersion),
              eq(documentChunks.catalogIndexVersion, 0),
            ),
      ),
    );

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

export async function writeCanonicalCatalogSource(
  config: CatalogImportConfig,
  env: Env,
  options?: { indexVersion?: number },
): Promise<void> {
  if (!config.sourceR2Key) return;
  const activeIndexVersion =
    options?.indexVersion ?? (await getActiveCatalogIndexVersion(config));

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
        eq(catalogProduct.indexVersion, activeIndexVersion),
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

async function insertCatalogProductVersion(
  config: CatalogImportConfig,
  product: NormalizedCatalogProduct,
  indexVersion: number,
): Promise<CatalogProduct> {
  const now = new Date();

  await db.insert(catalogProduct).values({
    id: product.id,
    agentId: config.agentId,
    sourceId: config.knowledgeSourceId,
    indexVersion,
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

  const [row] = await db
    .select()
    .from(catalogProduct)
    .where(eq(catalogProduct.id, product.id))
    .limit(1);

  if (!row) throw new Error(`Catalog product ${product.recordKey} not found`);
  return row;
}

async function replaceCatalogProductFacts(
  config: CatalogImportConfig,
  product: CatalogProduct,
): Promise<{ factsInserted: number }> {
  await db
    .delete(catalogProductFact)
    .where(eq(catalogProductFact.productId, product.id));

  const factInputs = collectFactInputs(config, product);
  if (factInputs.length === 0) return { factsInserted: 0 };

  const now = new Date();
  const rows = await Promise.all(
    factInputs.map(async (fact) => ({
      id: await makeCatalogFactId({
        productId: product.id,
        fieldPath: fact.fieldPath,
        role: fact.role,
        normalizedValue: fact.normalizedValue,
        indexVersion: product.indexVersion,
      }),
      agentId: config.agentId,
      sourceId: config.knowledgeSourceId,
      indexVersion: product.indexVersion,
      productId: product.id,
      fieldPath: fact.fieldPath,
      role: fact.role,
      value: fact.value,
      normalizedValue: fact.normalizedValue,
      createdAt: now,
    })),
  );

  for (let index = 0; index < rows.length; index += 10) {
    await db.insert(catalogProductFact).values(rows.slice(index, index + 10));
  }

  return { factsInserted: rows.length };
}

function collectFactInputs(
  config: CatalogImportConfig,
  product: CatalogProduct,
): CatalogFieldFactInput[] {
  const base = collectCatalogFacts(config, {
    recordKey: product.recordKey,
    title: product.title ?? product.recordKey,
    data: product.data ?? {},
  }).map((fact) => ({
    ...fact,
    normalizedValue: normalizeCatalogFactValue(fact.role, fact.value),
  }));

  const exactBase = collectCatalogFacts(
    {
      ...config,
      exactMatchFields: uniqueFieldList([
        config.stableKeyField,
        config.titleField,
        ...(config.exactMatchFields ?? []),
      ]),
    },
    {
      recordKey: product.recordKey,
      title: product.title ?? product.recordKey,
      data: product.data ?? {},
    },
  )
    .filter(
      (fact) =>
        fact.role === "exact" ||
        fact.role === "stable_key" ||
        fact.role === "title",
    )
    .map((fact) => ({
      ...fact,
      role:
        fact.role === "stable_key" || fact.role === "title"
          ? fact.role
          : ("exact" as const),
      normalizedValue: normalizeCatalogFactValue(
        fact.role === "stable_key" || fact.role === "title"
          ? fact.role
          : "exact",
        fact.value,
      ),
    }));

  const seen = new Set<string>();
  return [...base, ...exactBase].filter((fact) => {
    if (!fact.normalizedValue) return false;
    const key = `${fact.role}:${fact.fieldPath}:${fact.normalizedValue}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function replaceCatalogProductChunks(
  config: CatalogImportConfig,
  product: CatalogProduct,
  env: Env,
): Promise<{ chunksInserted: number; vectorsUpserted: number }> {
  const chunks = buildProductChunks(config, product);
  if (chunks.length === 0) {
    return { chunksInserted: 0, vectorsUpserted: 0 };
  }

  const embeddings = await generateEmbeddings(
    chunks.map((chunk) => chunk.text),
  );
  const now = new Date();
  const insertedIds: string[] = [];
  const upsertedVectorIds: string[] = [];

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
        catalogIndexVersion: product.indexVersion,
        recordKey: product.recordKey,
        recordHash: product.recordHash,
        metadata: {
          catalogProduct: true,
          catalogConfigId: config.id,
          catalogIndexVersion: product.indexVersion,
          catalogOrigin: config.origin,
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
              catalogIndexVersion: product.indexVersion,
              productId: product.id,
              recordKey: product.recordKey,
            },
          };
        }),
      );
      upsertedVectorIds.push(...batch.map((chunk) => chunk.id));
    }
  } catch (error) {
    if (upsertedVectorIds.length > 0) {
      try {
        await deleteVectorizeIds(env.VECTORIZE, upsertedVectorIds, {
          namespace: config.agentId,
          logPrefix: "Catalog Vectorize rollback",
        });
      } catch (deleteError) {
        console.error(
          `[Catalog] Failed rolling back ${upsertedVectorIds.length} vectors for source ${config.knowledgeSourceId}; failed index version remains hidden by active index version filters`,
          deleteError,
        );
      }
    }
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

function buildProductChunks(
  config: CatalogImportConfig,
  product: CatalogProduct,
): ProductChunk[] {
  const data = product.data ?? {};
  const fields = uniqueFieldList([
    config.stableKeyField,
    config.titleField,
    ...(config.exactMatchFields ?? []),
    ...(config.searchableFields ?? []),
    ...(config.filterableFields ?? []),
  ]);

  const headerLines = [
    `Product: ${product.title ?? product.recordKey}`,
    `Record key: ${product.recordKey}`,
  ];
  const fieldLines: string[] = [];

  for (const field of fields) {
    const value = stringifyValue(getPathValue(data, field));
    if (value) fieldLines.push(`${field}: ${value}`);
  }

  const header = headerLines.join("\n");
  const bodyText = fieldLines.join("\n");
  const baseText = bodyText ? `${header}\n${bodyText}` : header;
  const maxChunkLength = Math.min(
    EMBEDDING_CONFIG.MAX_INPUT_CHARS,
    Math.max(4000, CHUNKING_CONFIG.CHUNK_SIZE * 4),
  );
  const maxBodyLength = Math.max(600, maxChunkLength - header.length - 1);
  const chunks: string[] = [];

  if (baseText.length <= maxChunkLength) {
    chunks.push(baseText);
  } else {
    let cursor = 0;
    while (cursor < bodyText.length) {
      chunks.push(
        `${header}\n${bodyText.slice(cursor, cursor + maxBodyLength)}`,
      );
      cursor += maxBodyLength;
    }
  }

  return chunks.map((text, index) => ({
    id: `catalog:${product.id}:${index}`,
    text,
    chunkIndex: index,
  }));
}

async function cleanupSupersededCatalogVersions(options: {
  config: CatalogImportConfig;
  activeVersion: number;
  env: Env;
}): Promise<void> {
  const oldChunkRows = await db
    .select({ id: documentChunks.id, vectorizeId: documentChunks.vectorizeId })
    .from(documentChunks)
    .where(
      and(
        eq(documentChunks.documentId, options.config.knowledgeSourceId),
        or(
          isNull(documentChunks.catalogIndexVersion),
          ne(documentChunks.catalogIndexVersion, options.activeVersion),
        ),
      ),
    );

  const vectorIds = oldChunkRows
    .map((chunk) => chunk.vectorizeId ?? chunk.id)
    .filter(Boolean);
  if (vectorIds.length > 0) {
    try {
      await deleteVectorizeIds(options.env.VECTORIZE, vectorIds, {
        namespace: options.config.agentId,
        logPrefix: "Catalog Vectorize cleanup",
      });
    } catch (error) {
      console.error(
        `[Catalog] Failed deleting superseded vectors for source ${options.config.knowledgeSourceId}; stale D1 rows will still be hidden by active index version filters`,
        error,
      );
    }
  }

  await db
    .delete(documentChunks)
    .where(
      and(
        eq(documentChunks.documentId, options.config.knowledgeSourceId),
        or(
          isNull(documentChunks.catalogIndexVersion),
          ne(documentChunks.catalogIndexVersion, options.activeVersion),
        ),
      ),
    );
  await db
    .delete(catalogProductFact)
    .where(
      and(
        eq(catalogProductFact.sourceId, options.config.knowledgeSourceId),
        ne(catalogProductFact.indexVersion, options.activeVersion),
      ),
    );
  await db
    .delete(catalogProduct)
    .where(
      and(
        eq(catalogProduct.sourceId, options.config.knowledgeSourceId),
        ne(catalogProduct.indexVersion, options.activeVersion),
      ),
    );
}

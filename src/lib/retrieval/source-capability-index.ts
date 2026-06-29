import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  catalogConfig,
  catalogProduct,
  catalogProductFact,
  documentChunks,
  knowledgeSource,
} from "@/db/schema";
import {
  normalizeCatalogScopeAliases,
  uniqueFieldList,
} from "@/lib/catalog/shared";
import type {
  CatalogFieldCapability,
  CatalogFilterValueSummary,
  CatalogScopeSummary,
  SourceCapabilities,
} from "./types";

export async function loadSourceCapabilities(options: {
  agentId: string;
  knowledgeSourceIds?: string[];
}): Promise<SourceCapabilities> {
  const [activeProductCount, fieldCapabilities, filterValueSummaries, scopes] =
    await Promise.all([
      countActiveCatalogProducts(options),
      listCatalogFieldCapabilities(options),
      listCatalogFilterValueSummaries(options),
      listCatalogScopes(options),
    ]);
  const indexedDocumentChunkCount = await countIndexedDocumentChunks(options);

  return {
    agentId: options.agentId,
    knowledgeSourceIds: options.knowledgeSourceIds,
    catalog: {
      available: activeProductCount > 0,
      activeProductCount,
      fieldCapabilities,
      filterValueSummaries,
      scopes,
    },
    documents: {
      available: indexedDocumentChunkCount > 0,
      indexedChunkCount: indexedDocumentChunkCount,
    },
  };
}

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
    .where(buildActiveCatalogProductWhere(options));

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
        buildActiveCatalogProductWhere(options),
        eq(catalogProductFact.indexVersion, catalogProduct.indexVersion),
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

export async function listCatalogScopes(options: {
  agentId: string;
  knowledgeSourceIds?: string[];
}): Promise<CatalogScopeSummary[]> {
  const rows = await db
    .select({
      sourceId: catalogConfig.knowledgeSourceId,
      scopeName: catalogConfig.scopeName,
      scopeAliases: catalogConfig.scopeAliases,
    })
    .from(catalogConfig)
    .innerJoin(
      knowledgeSource,
      eq(knowledgeSource.id, catalogConfig.knowledgeSourceId),
    )
    .where(buildActiveCatalogConfigWhere(options));

  return rows
    .map((row) => ({
      sourceId: row.sourceId,
      name: row.scopeName,
      aliases: normalizeCatalogScopeAliases(row),
    }))
    .filter((scope) => scope.aliases.length > 0);
}

async function countIndexedDocumentChunks(options: {
  agentId: string;
  knowledgeSourceIds?: string[];
}): Promise<number> {
  const sourceFilter =
    options.knowledgeSourceIds && options.knowledgeSourceIds.length > 0
      ? inArray(documentChunks.documentId, options.knowledgeSourceIds)
      : undefined;

  const [row] = await db
    .select({ total: count() })
    .from(documentChunks)
    .innerJoin(
      knowledgeSource,
      eq(documentChunks.documentId, knowledgeSource.id),
    )
    .where(
      and(
        eq(documentChunks.sessionId, options.agentId),
        eq(knowledgeSource.status, "indexed"),
        sourceFilter,
      ),
    );

  return Number(row?.total ?? 0);
}

export function buildActiveCatalogProductWhere(options: {
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
    eq(knowledgeSource.status, "indexed"),
    eq(catalogProduct.indexVersion, catalogConfig.activeIndexVersion),
    sourceFilter,
  );
}

export function buildActiveCatalogConfigWhere(options: {
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
    eq(knowledgeSource.status, "indexed"),
    sourceFilter,
  );
}

function dedupeCatalogCapabilities(
  capabilities: CatalogFieldCapability[],
): CatalogFieldCapability[] {
  const seen = new Set<string>();
  return uniqueFieldList(capabilities.map((capability) => capability.fieldPath))
    .flatMap((fieldPath) =>
      capabilities.filter((capability) => capability.fieldPath === fieldPath),
    )
    .filter((capability) => {
      const fieldPath = capability.fieldPath.trim();
      if (!fieldPath) return false;
      const key = `${capability.role}:${fieldPath}`;
      if (seen.has(key)) return false;
      seen.add(key);
      capability.fieldPath = fieldPath;
      return true;
    });
}

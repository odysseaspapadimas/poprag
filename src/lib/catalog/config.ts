import { eq } from "drizzle-orm";
import { db } from "@/db";
import { catalogConfig, knowledgeSource } from "@/db/schema";
import {
  type CatalogFieldRole,
  type CatalogImportConfig,
  type CatalogMapping,
  uniqueFieldList,
} from "./shared";

export type CatalogConfigRow = typeof catalogConfig.$inferSelect & {
  sourceFileName: string | null;
  sourceR2Key: string | null;
  sourceMime: string | null;
  sourceStatus: string;
};

export async function loadCatalogImportConfigById(
  catalogConfigId: string,
): Promise<CatalogImportConfig | undefined> {
  const [row] = await db
    .select({
      id: catalogConfig.id,
      agentId: catalogConfig.agentId,
      knowledgeSourceId: catalogConfig.knowledgeSourceId,
      experienceId: catalogConfig.experienceId,
      name: catalogConfig.name,
      origin: catalogConfig.origin,
      enabled: catalogConfig.enabled,
      stableKeyField: catalogConfig.stableKeyField,
      updatedAtField: catalogConfig.updatedAtField,
      deletionField: catalogConfig.deletionField,
      deletionInactiveValues: catalogConfig.deletionInactiveValues,
      titleField: catalogConfig.titleField,
      searchableFields: catalogConfig.searchableFields,
      exactMatchFields: catalogConfig.exactMatchFields,
      filterableFields: catalogConfig.filterableFields,
      activeIndexVersion: catalogConfig.activeIndexVersion,
      createdAt: catalogConfig.createdAt,
      updatedAt: catalogConfig.updatedAt,
      sourceFileName: knowledgeSource.fileName,
      sourceR2Key: knowledgeSource.r2Key,
      sourceMime: knowledgeSource.mime,
      sourceStatus: knowledgeSource.status,
    })
    .from(catalogConfig)
    .innerJoin(
      knowledgeSource,
      eq(knowledgeSource.id, catalogConfig.knowledgeSourceId),
    )
    .where(eq(catalogConfig.id, catalogConfigId))
    .limit(1);

  return row ? toCatalogImportConfig(row) : undefined;
}

export async function loadCatalogImportConfigBySourceId(
  sourceId: string,
): Promise<CatalogImportConfig | undefined> {
  const [row] = await db
    .select({
      id: catalogConfig.id,
      agentId: catalogConfig.agentId,
      knowledgeSourceId: catalogConfig.knowledgeSourceId,
      experienceId: catalogConfig.experienceId,
      name: catalogConfig.name,
      origin: catalogConfig.origin,
      enabled: catalogConfig.enabled,
      stableKeyField: catalogConfig.stableKeyField,
      updatedAtField: catalogConfig.updatedAtField,
      deletionField: catalogConfig.deletionField,
      deletionInactiveValues: catalogConfig.deletionInactiveValues,
      titleField: catalogConfig.titleField,
      searchableFields: catalogConfig.searchableFields,
      exactMatchFields: catalogConfig.exactMatchFields,
      filterableFields: catalogConfig.filterableFields,
      activeIndexVersion: catalogConfig.activeIndexVersion,
      createdAt: catalogConfig.createdAt,
      updatedAt: catalogConfig.updatedAt,
      sourceFileName: knowledgeSource.fileName,
      sourceR2Key: knowledgeSource.r2Key,
      sourceMime: knowledgeSource.mime,
      sourceStatus: knowledgeSource.status,
    })
    .from(catalogConfig)
    .innerJoin(
      knowledgeSource,
      eq(knowledgeSource.id, catalogConfig.knowledgeSourceId),
    )
    .where(eq(catalogConfig.knowledgeSourceId, sourceId))
    .limit(1);

  return row ? toCatalogImportConfig(row) : undefined;
}

export function toCatalogImportConfig(
  row: CatalogConfigRow,
): CatalogImportConfig {
  return {
    id: row.id,
    agentId: row.agentId,
    knowledgeSourceId: row.knowledgeSourceId,
    name: row.name,
    origin: row.origin,
    enabled: row.enabled,
    stableKeyField: row.stableKeyField,
    updatedAtField: row.updatedAtField,
    deletionField: row.deletionField,
    deletionInactiveValues: row.deletionInactiveValues,
    titleField: row.titleField,
    searchableFields: row.searchableFields,
    exactMatchFields: row.exactMatchFields,
    filterableFields: row.filterableFields,
    sourceFileName: row.sourceFileName,
    sourceR2Key: row.sourceR2Key,
  };
}

export interface CatalogMappingCapability {
  fieldPath: string;
  role: CatalogFieldRole;
}

export function getCatalogMapping(config: CatalogMapping): CatalogMapping {
  return {
    stableKeyField: config.stableKeyField,
    updatedAtField: config.updatedAtField,
    deletionField: config.deletionField,
    deletionInactiveValues: config.deletionInactiveValues,
    titleField: config.titleField,
    searchableFields: config.searchableFields ?? [],
    exactMatchFields: config.exactMatchFields ?? [],
    filterableFields: config.filterableFields ?? [],
  };
}

export function listCatalogMappingCapabilities(
  config: CatalogMapping,
): CatalogMappingCapability[] {
  const mapping = getCatalogMapping(config);
  const capabilities: CatalogMappingCapability[] = [
    { fieldPath: mapping.stableKeyField, role: "stable_key" },
    { fieldPath: mapping.titleField, role: "title" },
    ...(mapping.exactMatchFields ?? []).map((fieldPath) => ({
      fieldPath,
      role: "exact" as const,
    })),
    ...(mapping.searchableFields ?? []).map((fieldPath) => ({
      fieldPath,
      role: "searchable" as const,
    })),
    ...(mapping.filterableFields ?? []).map((fieldPath) => ({
      fieldPath,
      role: "filterable" as const,
    })),
  ];

  const seen = new Set<string>();
  return capabilities
    .map((capability) => ({
      ...capability,
      fieldPath: capability.fieldPath.trim(),
    }))
    .filter((capability) => {
      if (!capability.fieldPath) return false;
      const key = `${capability.role}:${capability.fieldPath}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function mergeCatalogFieldList(
  fields: Array<string[] | null | undefined>,
): string[] {
  return uniqueFieldList(fields.flatMap((fieldList) => fieldList ?? []));
}

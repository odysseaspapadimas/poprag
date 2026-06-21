import { and, count, desc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "@/db";
import {
  agentExperience,
  agentExperienceKnowledge,
  catalogConfig,
  catalogProduct,
  catalogSyncConfig,
  catalogSyncRun,
  knowledgeSource,
} from "@/db/schema";
import { audit, requireAgent } from "@/integrations/trpc/helpers";
import { createTRPCRouter, protectedProcedure } from "@/integrations/trpc/init";
import {
  type CatalogApplyProgress,
  rebuildCatalogIndexFromActiveProducts,
} from "@/lib/catalog/apply";
import { loadCatalogImportConfigById } from "@/lib/catalog/config";
import {
  type CatalogSyncMode,
  computeNextCatalogRunAt,
} from "@/lib/catalog/sync";

const catalogFieldListSchema = z.array(z.string().trim().min(1)).default([]);
const DEFAULT_UPDATED_SINCE_PARAM = "effectiveUpdatedAfter";
const MAPPING_REBUILD_PROGRESS_START = 5;
const MAPPING_REBUILD_NORMALIZE_START = 10;
const MAPPING_REBUILD_NORMALIZE_END = 30;
const MAPPING_REBUILD_INDEX_START = 30;
const MAPPING_REBUILD_INDEX_END = 88;

const catalogConfigInput = z.object({
  name: z.string().min(1).max(200),
  experienceId: z.string().nullable().optional(),
  snapshotUrl: z.string().url(),
  diffUrl: z.union([z.string().url(), z.literal("")]).default(""),
  authHeaderName: z.string().trim().min(1).max(100).nullable().optional(),
  authSecretName: z.string().trim().min(1).max(100).nullable().optional(),
  updatedSinceParam: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .default(DEFAULT_UPDATED_SINCE_PARAM),
  itemPath: z.string().trim().max(200).default(""),
  stableKeyField: z.string().trim().min(1).max(200),
  updatedAtField: z.string().trim().max(200).nullable().optional(),
  deletionField: z.string().trim().max(200).nullable().optional(),
  deletionInactiveValues: catalogFieldListSchema.default([
    "false",
    "inactive",
    "deleted",
    "0",
    "no",
  ]),
  titleField: z.string().trim().min(1).max(200),
  searchableFields: catalogFieldListSchema,
  exactMatchFields: catalogFieldListSchema,
  filterableFields: catalogFieldListSchema,
  syncIntervalDays: z.number().int().min(1).max(31).default(7),
  scheduleWeekdayUtc: z.number().int().min(0).max(6).default(1),
  scheduleHourUtc: z.number().int().min(0).max(23).default(3),
  enabled: z.boolean().default(true),
});

function getMappingRebuildProgress(state: CatalogApplyProgress): number {
  if (state.total <= 0) {
    return state.phase === "normalize"
      ? MAPPING_REBUILD_NORMALIZE_END
      : MAPPING_REBUILD_INDEX_END;
  }

  const ratio = Math.min(1, Math.max(0, state.processed / state.total));
  const start =
    state.phase === "normalize"
      ? MAPPING_REBUILD_NORMALIZE_START
      : MAPPING_REBUILD_INDEX_START;
  const end =
    state.phase === "normalize"
      ? MAPPING_REBUILD_NORMALIZE_END
      : MAPPING_REBUILD_INDEX_END;
  return Math.round(start + ratio * (end - start));
}

function formatMappingRebuildProgressMessage(
  state: CatalogApplyProgress,
): string {
  if (state.total <= 0) {
    return "Rebuilding catalog index for updated mapping";
  }

  if (state.phase === "normalize") {
    return `Preparing catalog products ${state.processed}/${state.total} for updated mapping`;
  }

  return `Rebuilding catalog index ${state.processed}/${state.total}: ${state.stats.created} created, ${state.stats.updated} updated, ${state.stats.unchanged} unchanged, ${state.stats.deactivated} hidden, ${state.stats.chunksInserted} chunks`;
}

function normalizeCatalogFileName(name: string): string {
  return `${
    name
      .normalize("NFKC")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "catalog"
  }.catalog.jsonl`;
}

async function requireCatalogConfig(configId: string) {
  const [config] = await db
    .select()
    .from(catalogSyncConfig)
    .where(eq(catalogSyncConfig.id, configId))
    .limit(1);

  if (!config) {
    throw new Error("Catalog sync config not found");
  }

  await requireAgent(config.agentId);
  return config;
}

async function validateExperience(
  agentId: string,
  experienceId?: string | null,
) {
  if (!experienceId) return null;

  const [experience] = await db
    .select({ id: agentExperience.id, agentId: agentExperience.agentId })
    .from(agentExperience)
    .where(eq(agentExperience.id, experienceId))
    .limit(1);

  if (!experience || experience.agentId !== agentId) {
    throw new Error("Experience not found for this agent");
  }

  return experience.id;
}

async function replaceExperienceLink(
  sourceId: string,
  experienceId?: string | null,
) {
  await db
    .delete(agentExperienceKnowledge)
    .where(eq(agentExperienceKnowledge.knowledgeSourceId, sourceId));

  if (experienceId) {
    await db.insert(agentExperienceKnowledge).values({
      experienceId,
      knowledgeSourceId: sourceId,
    });
  }
}

async function getKnowledgeSourceState(sourceId: string) {
  const [source] = await db
    .select({
      status: knowledgeSource.status,
      progress: knowledgeSource.progress,
    })
    .from(knowledgeSource)
    .where(eq(knowledgeSource.id, sourceId))
    .limit(1);

  return source;
}

export const catalogSyncRouter = createTRPCRouter({
  list: protectedProcedure
    .input(z.object({ agentId: z.string() }))
    .query(async ({ input }) => {
      await requireAgent(input.agentId);

      const rows = await db
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
          filterableFields: catalogConfig.filterableFields,
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
          sourceStatus: knowledgeSource.status,
          sourceProgress: knowledgeSource.progress,
          sourceProgressMessage: knowledgeSource.progressMessage,
        })
        .from(catalogSyncConfig)
        .innerJoin(
          knowledgeSource,
          eq(knowledgeSource.id, catalogSyncConfig.knowledgeSourceId),
        )
        .innerJoin(
          catalogConfig,
          eq(catalogConfig.id, catalogSyncConfig.catalogConfigId),
        )
        .where(eq(catalogSyncConfig.agentId, input.agentId))
        .orderBy(desc(catalogSyncConfig.createdAt));

      if (rows.length === 0) return [];

      const sourceIds = rows.map((row) => row.knowledgeSourceId);
      const productCounts = await db
        .select({
          sourceId: catalogProduct.sourceId,
          status: catalogProduct.status,
          count: count(),
        })
        .from(catalogProduct)
        .innerJoin(
          catalogConfig,
          eq(catalogConfig.knowledgeSourceId, catalogProduct.sourceId),
        )
        .where(
          and(
            inArray(catalogProduct.sourceId, sourceIds),
            eq(catalogProduct.indexVersion, catalogConfig.activeIndexVersion),
          ),
        )
        .groupBy(catalogProduct.sourceId, catalogProduct.status);

      const countsBySource = new Map<
        string,
        { active: number; inactive: number; total: number }
      >();
      for (const row of productCounts) {
        const current = countsBySource.get(row.sourceId) ?? {
          active: 0,
          inactive: 0,
          total: 0,
        };
        current[row.status] = row.count;
        current.total += row.count;
        countsBySource.set(row.sourceId, current);
      }

      return rows.map((row) => ({
        ...row,
        productCounts: countsBySource.get(row.knowledgeSourceId) ?? {
          active: 0,
          inactive: 0,
          total: 0,
        },
      }));
    }),

  get: protectedProcedure
    .input(z.object({ configId: z.string() }))
    .query(async ({ input }) => {
      const [config] = await db
        .select({
          id: catalogSyncConfig.id,
          catalogConfigId: catalogSyncConfig.catalogConfigId,
          agentId: catalogSyncConfig.agentId,
          knowledgeSourceId: catalogSyncConfig.knowledgeSourceId,
          experienceId: catalogConfig.experienceId,
          name: catalogConfig.name,
          enabled: catalogConfig.enabled,
          snapshotUrl: catalogSyncConfig.snapshotUrl,
          diffUrl: catalogSyncConfig.diffUrl,
          authHeaderName: catalogSyncConfig.authHeaderName,
          authSecretName: catalogSyncConfig.authSecretName,
          updatedSinceParam: catalogSyncConfig.updatedSinceParam,
          itemPath: catalogSyncConfig.itemPath,
          stableKeyField: catalogConfig.stableKeyField,
          updatedAtField: catalogConfig.updatedAtField,
          deletionField: catalogConfig.deletionField,
          deletionInactiveValues: catalogConfig.deletionInactiveValues,
          titleField: catalogConfig.titleField,
          searchableFields: catalogConfig.searchableFields,
          exactMatchFields: catalogConfig.exactMatchFields,
          filterableFields: catalogConfig.filterableFields,
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
        })
        .from(catalogSyncConfig)
        .innerJoin(
          catalogConfig,
          eq(catalogConfig.id, catalogSyncConfig.catalogConfigId),
        )
        .where(eq(catalogSyncConfig.id, input.configId))
        .limit(1);

      if (!config) {
        throw new Error("Catalog sync config not found");
      }

      await requireAgent(config.agentId);
      return config;
    }),

  create: protectedProcedure
    .input(catalogConfigInput.extend({ agentId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await requireAgent(input.agentId);
      const experienceId = await validateExperience(
        input.agentId,
        input.experienceId,
      );

      const sourceId = nanoid();
      const configId = nanoid();
      const sharedCatalogConfigId = nanoid();
      const fileName = normalizeCatalogFileName(input.name);
      const r2Key = `agents/${input.agentId}/catalogs/${sourceId}/${fileName}`;
      const now = new Date();
      const nextRunAt = computeNextCatalogRunAt(input, now);
      const diffUrl = input.diffUrl || input.snapshotUrl;

      await db.insert(knowledgeSource).values({
        id: sourceId,
        agentId: input.agentId,
        type: "dataset",
        r2Bucket: "poprag",
        r2Key,
        fileName,
        mime: "application/x-ndjson",
        bytes: 0,
        status: "uploaded",
        progress: 0,
        progressMessage: "Catalog sync configured",
        parserErrors: [],
        vectorizeIds: [],
        createdAt: now,
        updatedAt: now,
      });

      await db.insert(catalogConfig).values({
        id: sharedCatalogConfigId,
        agentId: input.agentId,
        knowledgeSourceId: sourceId,
        experienceId,
        name: input.name,
        origin: "api",
        enabled: input.enabled,
        stableKeyField: input.stableKeyField,
        updatedAtField: input.updatedAtField || null,
        deletionField: input.deletionField || null,
        deletionInactiveValues: input.deletionInactiveValues,
        titleField: input.titleField,
        searchableFields: input.searchableFields,
        exactMatchFields: input.exactMatchFields,
        filterableFields: input.filterableFields,
        createdAt: now,
        updatedAt: now,
      });

      await db.insert(catalogSyncConfig).values({
        id: configId,
        catalogConfigId: sharedCatalogConfigId,
        agentId: input.agentId,
        knowledgeSourceId: sourceId,
        experienceId,
        name: input.name,
        enabled: input.enabled,
        snapshotUrl: input.snapshotUrl,
        diffUrl,
        authHeaderName: input.authHeaderName || null,
        authSecretName: input.authSecretName || null,
        updatedSinceParam: input.updatedSinceParam,
        itemPath: input.itemPath,
        stableKeyField: input.stableKeyField,
        updatedAtField: input.updatedAtField || null,
        deletionField: input.deletionField || null,
        deletionInactiveValues: input.deletionInactiveValues,
        titleField: input.titleField,
        searchableFields: input.searchableFields,
        exactMatchFields: input.exactMatchFields,
        syncIntervalDays: input.syncIntervalDays,
        scheduleWeekdayUtc: input.scheduleWeekdayUtc,
        scheduleHourUtc: input.scheduleHourUtc,
        nextRunAt,
        createdAt: now,
        updatedAt: now,
      });

      if (experienceId) {
        await replaceExperienceLink(sourceId, experienceId);
      }

      await audit(
        ctx,
        "knowledge.catalog_sync.created",
        { type: "knowledge_source", id: sourceId },
        { configId, name: input.name, experienceId },
      );

      return { configId, catalogConfigId: sharedCatalogConfigId, sourceId };
    }),

  update: protectedProcedure
    .input(catalogConfigInput.partial().extend({ configId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const config = await requireCatalogConfig(input.configId);
      const experienceId =
        input.experienceId !== undefined
          ? await validateExperience(config.agentId, input.experienceId)
          : undefined;
      const mappingChanged =
        input.stableKeyField !== undefined ||
        input.updatedAtField !== undefined ||
        input.deletionField !== undefined ||
        input.deletionInactiveValues !== undefined ||
        input.titleField !== undefined ||
        input.searchableFields !== undefined ||
        input.exactMatchFields !== undefined ||
        input.filterableFields !== undefined;
      const currentSourceState = mappingChanged
        ? await getKnowledgeSourceState(config.knowledgeSourceId)
        : undefined;
      const currentImportConfig =
        mappingChanged && config.catalogConfigId
          ? await loadCatalogImportConfigById(config.catalogConfigId)
          : undefined;
      if (mappingChanged && !currentImportConfig) {
        throw new Error("Catalog config not found");
      }
      let indexRebuilt:
        | {
            version: number;
            stats: Awaited<
              ReturnType<typeof rebuildCatalogIndexFromActiveProducts>
            >["stats"];
          }
        | undefined;

      const updateValues: Partial<typeof catalogSyncConfig.$inferInsert> = {
        updatedAt: new Date(),
      };

      if (input.name !== undefined) updateValues.name = input.name;
      if (experienceId !== undefined) updateValues.experienceId = experienceId;
      if (input.enabled !== undefined) updateValues.enabled = input.enabled;
      if (input.snapshotUrl !== undefined)
        updateValues.snapshotUrl = input.snapshotUrl;
      if (input.diffUrl !== undefined) {
        updateValues.diffUrl =
          input.diffUrl || input.snapshotUrl || config.snapshotUrl;
      } else if (
        input.snapshotUrl !== undefined &&
        config.diffUrl === config.snapshotUrl
      ) {
        updateValues.diffUrl = input.snapshotUrl;
      }
      if (input.authHeaderName !== undefined)
        updateValues.authHeaderName = input.authHeaderName || null;
      if (input.authSecretName !== undefined)
        updateValues.authSecretName = input.authSecretName || null;
      if (input.updatedSinceParam !== undefined)
        updateValues.updatedSinceParam = input.updatedSinceParam;
      if (input.itemPath !== undefined) updateValues.itemPath = input.itemPath;
      if (input.stableKeyField !== undefined)
        updateValues.stableKeyField = input.stableKeyField;
      if (input.updatedAtField !== undefined)
        updateValues.updatedAtField = input.updatedAtField || null;
      if (input.deletionField !== undefined)
        updateValues.deletionField = input.deletionField || null;
      if (input.deletionInactiveValues !== undefined)
        updateValues.deletionInactiveValues = input.deletionInactiveValues;
      if (input.titleField !== undefined)
        updateValues.titleField = input.titleField;
      if (input.searchableFields !== undefined)
        updateValues.searchableFields = input.searchableFields;
      if (input.exactMatchFields !== undefined)
        updateValues.exactMatchFields = input.exactMatchFields;
      if (input.syncIntervalDays !== undefined)
        updateValues.syncIntervalDays = input.syncIntervalDays;
      if (input.scheduleWeekdayUtc !== undefined)
        updateValues.scheduleWeekdayUtc = input.scheduleWeekdayUtc;
      if (input.scheduleHourUtc !== undefined)
        updateValues.scheduleHourUtc = input.scheduleHourUtc;

      const scheduleCandidate = {
        syncIntervalDays: input.syncIntervalDays ?? config.syncIntervalDays,
        scheduleWeekdayUtc:
          input.scheduleWeekdayUtc ?? config.scheduleWeekdayUtc,
        scheduleHourUtc: input.scheduleHourUtc ?? config.scheduleHourUtc,
      };
      updateValues.nextRunAt = computeNextCatalogRunAt(scheduleCandidate);

      const catalogUpdateValues: Partial<typeof catalogConfig.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (input.name !== undefined) catalogUpdateValues.name = input.name;
      if (experienceId !== undefined)
        catalogUpdateValues.experienceId = experienceId;
      if (input.enabled !== undefined)
        catalogUpdateValues.enabled = input.enabled;
      if (input.stableKeyField !== undefined)
        catalogUpdateValues.stableKeyField = input.stableKeyField;
      if (input.updatedAtField !== undefined)
        catalogUpdateValues.updatedAtField = input.updatedAtField || null;
      if (input.deletionField !== undefined)
        catalogUpdateValues.deletionField = input.deletionField || null;
      if (input.deletionInactiveValues !== undefined)
        catalogUpdateValues.deletionInactiveValues =
          input.deletionInactiveValues;
      if (input.titleField !== undefined)
        catalogUpdateValues.titleField = input.titleField;
      if (input.searchableFields !== undefined)
        catalogUpdateValues.searchableFields = input.searchableFields;
      if (input.exactMatchFields !== undefined)
        catalogUpdateValues.exactMatchFields = input.exactMatchFields;
      if (input.filterableFields !== undefined)
        catalogUpdateValues.filterableFields = input.filterableFields;

      if (mappingChanged) {
        const nextImportConfig = {
          ...currentImportConfig!,
          name: input.name ?? currentImportConfig!.name,
          enabled: input.enabled ?? currentImportConfig!.enabled,
          stableKeyField:
            input.stableKeyField ?? currentImportConfig!.stableKeyField,
          updatedAtField:
            input.updatedAtField !== undefined
              ? input.updatedAtField || null
              : currentImportConfig!.updatedAtField,
          deletionField:
            input.deletionField !== undefined
              ? input.deletionField || null
              : currentImportConfig!.deletionField,
          deletionInactiveValues:
            input.deletionInactiveValues ??
            currentImportConfig!.deletionInactiveValues,
          titleField: input.titleField ?? currentImportConfig!.titleField,
          searchableFields:
            input.searchableFields ?? currentImportConfig!.searchableFields,
          exactMatchFields:
            input.exactMatchFields ?? currentImportConfig!.exactMatchFields,
          filterableFields:
            input.filterableFields ?? currentImportConfig!.filterableFields,
        };
        const { env } = await import("cloudflare:workers");
        let lastProgressReportAt = 0;
        let lastProgress = MAPPING_REBUILD_PROGRESS_START;
        const reportMappingRebuildProgress = async (
          state: CatalogApplyProgress,
        ) => {
          const now = Date.now();
          if (
            state.processed < state.total &&
            state.processed % 10 !== 0 &&
            now - lastProgressReportAt < 5000
          ) {
            return;
          }

          lastProgressReportAt = now;
          lastProgress = Math.max(
            lastProgress,
            getMappingRebuildProgress(state),
          );
          await db
            .update(knowledgeSource)
            .set({
              status: "processing",
              progress: lastProgress,
              progressMessage: formatMappingRebuildProgressMessage(state),
              parserErrors: [],
              updatedAt: new Date(),
            })
            .where(eq(knowledgeSource.id, config.knowledgeSourceId));
        };
        await db
          .update(knowledgeSource)
          .set({
            status: "processing",
            progress: MAPPING_REBUILD_PROGRESS_START,
            progressMessage: "Rebuilding catalog index for updated mapping",
            parserErrors: [],
            updatedAt: new Date(),
          })
          .where(eq(knowledgeSource.id, config.knowledgeSourceId));
        try {
          const rebuildResult = await rebuildCatalogIndexFromActiveProducts({
            config: nextImportConfig,
            env,
            catalogConfigUpdates: catalogUpdateValues,
            onProgress: reportMappingRebuildProgress,
          });
          indexRebuilt = {
            version: rebuildResult.build.version,
            stats: rebuildResult.stats,
          };
          await db
            .update(catalogSyncConfig)
            .set(updateValues)
            .where(eq(catalogSyncConfig.id, input.configId));
          await db
            .update(knowledgeSource)
            .set({
              status: "indexed",
              progress: 100,
              progressMessage: `Catalog mapping updated and index rebuilt: ${rebuildResult.stats.created} created, ${rebuildResult.stats.updated} updated, ${rebuildResult.stats.unchanged} unchanged`,
              parserErrors: [],
              updatedAt: new Date(),
            })
            .where(eq(knowledgeSource.id, config.knowledgeSourceId));
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          await db
            .update(knowledgeSource)
            .set({
              status: currentSourceState?.status ?? "indexed",
              progress: currentSourceState?.progress ?? 100,
              progressMessage: `Catalog mapping update failed: ${message}`,
              parserErrors: [message],
              updatedAt: new Date(),
            })
            .where(eq(knowledgeSource.id, config.knowledgeSourceId));
          throw error;
        }
      } else {
        await db
          .update(catalogSyncConfig)
          .set(updateValues)
          .where(eq(catalogSyncConfig.id, input.configId));

        if (config.catalogConfigId) {
          await db
            .update(catalogConfig)
            .set(catalogUpdateValues)
            .where(eq(catalogConfig.id, config.catalogConfigId));
        }
      }

      if (experienceId !== undefined) {
        await replaceExperienceLink(config.knowledgeSourceId, experienceId);
      }

      if (input.name !== undefined) {
        await db
          .update(knowledgeSource)
          .set({
            fileName: normalizeCatalogFileName(input.name),
            updatedAt: new Date(),
          })
          .where(eq(knowledgeSource.id, config.knowledgeSourceId));
      }

      await audit(
        ctx,
        "knowledge.catalog_sync.updated",
        { type: "knowledge_source", id: config.knowledgeSourceId },
        {
          configId: input.configId,
          ...(indexRebuilt ? { indexRebuilt } : {}),
        },
      );

      return { success: true };
    }),

  disable: protectedProcedure
    .input(z.object({ configId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const config = await requireCatalogConfig(input.configId);

      await db
        .update(catalogSyncConfig)
        .set({
          enabled: false,
          nextRunAt: null,
          updatedAt: new Date(),
        })
        .where(eq(catalogSyncConfig.id, input.configId));

      if (config.catalogConfigId) {
        await db
          .update(catalogConfig)
          .set({ enabled: false, updatedAt: new Date() })
          .where(eq(catalogConfig.id, config.catalogConfigId));
      }

      await audit(
        ctx,
        "knowledge.catalog_sync.disabled",
        { type: "knowledge_source", id: config.knowledgeSourceId },
        { configId: input.configId },
      );

      return { success: true };
    }),

  run: protectedProcedure
    .input(
      z.object({
        configId: z.string(),
        mode: z.enum(["auto", "diff", "snapshot"]).default("auto"),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const config = await requireCatalogConfig(input.configId);
      const { env } = await import("cloudflare:workers");
      const instanceId = `catalog-sync-${input.configId}-${Date.now()}`;

      const instance = await env.CATALOG_SYNC_WORKFLOW.create({
        id: instanceId,
        params: {
          configId: input.configId,
          trigger: "manual",
          mode: input.mode satisfies CatalogSyncMode,
        },
      });

      await db
        .update(catalogSyncConfig)
        .set({
          lastRunStatus: "queued",
          lastRunError: null,
          updatedAt: new Date(),
        })
        .where(eq(catalogSyncConfig.id, input.configId));

      await audit(
        ctx,
        "knowledge.catalog_sync.queued",
        { type: "knowledge_source", id: config.knowledgeSourceId },
        { configId: input.configId, mode: input.mode, instanceId: instance.id },
      );

      return { success: true, workflowInstanceId: instance.id };
    }),

  runs: protectedProcedure
    .input(
      z.object({
        configId: z.string(),
        limit: z.number().int().min(1).max(50).default(20),
      }),
    )
    .query(async ({ input }) => {
      const config = await requireCatalogConfig(input.configId);

      return await db
        .select()
        .from(catalogSyncRun)
        .where(
          and(
            eq(catalogSyncRun.configId, input.configId),
            eq(catalogSyncRun.agentId, config.agentId),
          ),
        )
        .orderBy(desc(catalogSyncRun.createdAt))
        .limit(input.limit);
    }),
});

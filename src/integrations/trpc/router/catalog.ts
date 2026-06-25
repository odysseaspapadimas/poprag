import { AwsClient } from "aws4fetch";
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
  knowledgeSource,
} from "@/db/schema";
import { audit, requireAgent } from "@/integrations/trpc/helpers";
import { createTRPCRouter, protectedProcedure } from "@/integrations/trpc/init";
import { MAX_KNOWLEDGE_FILE_SIZE } from "@/lib/ai/constants";
import {
  type CatalogApplyProgress,
  rebuildCatalogFactsForSource,
  rebuildCatalogIndexFromActiveProducts,
} from "@/lib/catalog/apply";
import { loadCatalogImportConfigById } from "@/lib/catalog/config";
import { processCsvCatalogSource } from "@/lib/catalog/csv";
import { createR2ObjectUrl, getR2BucketName } from "@/lib/r2";

const catalogFieldListSchema = z.array(z.string().trim().min(1)).default([]);
const catalogScopeAliasListSchema = z
  .array(z.string().trim().min(1).max(200))
  .default([]);
const MAPPING_REBUILD_PROGRESS_START = 5;
const MAPPING_REBUILD_NORMALIZE_START = 10;
const MAPPING_REBUILD_NORMALIZE_END = 30;
const MAPPING_REBUILD_INDEX_START = 30;
const MAPPING_REBUILD_INDEX_END = 88;

const catalogMappingInput = z.object({
  name: z.string().min(1).max(200),
  scopeName: z.string().trim().max(200).nullable().optional(),
  scopeAliases: catalogScopeAliasListSchema,
  experienceId: z.string().nullable().optional(),
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

async function requireCatalogConfig(catalogConfigId: string) {
  const [config] = await db
    .select()
    .from(catalogConfig)
    .where(eq(catalogConfig.id, catalogConfigId))
    .limit(1);

  if (!config) throw new Error("Catalog config not found");
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

export const catalogRouter = createTRPCRouter({
  list: protectedProcedure
    .input(z.object({ agentId: z.string() }))
    .query(async ({ input }) => {
      await requireAgent(input.agentId);

      const rows = await db
        .select({
          id: catalogConfig.id,
          agentId: catalogConfig.agentId,
          knowledgeSourceId: catalogConfig.knowledgeSourceId,
          experienceId: catalogConfig.experienceId,
          name: catalogConfig.name,
          scopeName: catalogConfig.scopeName,
          scopeAliases: catalogConfig.scopeAliases,
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
          createdAt: catalogConfig.createdAt,
          updatedAt: catalogConfig.updatedAt,
          sourceFileName: knowledgeSource.fileName,
          sourceStatus: knowledgeSource.status,
          sourceProgress: knowledgeSource.progress,
          sourceProgressMessage: knowledgeSource.progressMessage,
          syncConfigId: catalogSyncConfig.id,
          snapshotUrl: catalogSyncConfig.snapshotUrl,
          diffUrl: catalogSyncConfig.diffUrl,
          authHeaderName: catalogSyncConfig.authHeaderName,
          authSecretName: catalogSyncConfig.authSecretName,
          updatedSinceParam: catalogSyncConfig.updatedSinceParam,
          itemPath: catalogSyncConfig.itemPath,
          syncIntervalDays: catalogSyncConfig.syncIntervalDays,
          scheduleWeekdayUtc: catalogSyncConfig.scheduleWeekdayUtc,
          scheduleHourUtc: catalogSyncConfig.scheduleHourUtc,
          lastRunStatus: catalogSyncConfig.lastRunStatus,
          lastRunError: catalogSyncConfig.lastRunError,
          lastSuccessfulSyncAt: catalogSyncConfig.lastSuccessfulSyncAt,
        })
        .from(catalogConfig)
        .innerJoin(
          knowledgeSource,
          eq(knowledgeSource.id, catalogConfig.knowledgeSourceId),
        )
        .leftJoin(
          catalogSyncConfig,
          eq(catalogSyncConfig.catalogConfigId, catalogConfig.id),
        )
        .where(eq(catalogConfig.agentId, input.agentId))
        .orderBy(desc(catalogConfig.createdAt));

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
    .input(z.object({ catalogConfigId: z.string() }))
    .query(async ({ input }) => {
      return requireCatalogConfig(input.catalogConfigId);
    }),

  updateMapping: protectedProcedure
    .input(
      catalogMappingInput.partial().extend({ catalogConfigId: z.string() }),
    )
    .mutation(async ({ input, ctx }) => {
      const config = await requireCatalogConfig(input.catalogConfigId);
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
      const currentImportConfig = mappingChanged
        ? await loadCatalogImportConfigById(input.catalogConfigId)
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

      const updateValues: Partial<typeof catalogConfig.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (input.name !== undefined) updateValues.name = input.name;
      if (input.scopeName !== undefined)
        updateValues.scopeName = input.scopeName || null;
      if (input.scopeAliases !== undefined)
        updateValues.scopeAliases = input.scopeAliases;
      if (experienceId !== undefined) updateValues.experienceId = experienceId;
      if (input.enabled !== undefined) updateValues.enabled = input.enabled;
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
      if (input.filterableFields !== undefined)
        updateValues.filterableFields = input.filterableFields;

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
            catalogConfigUpdates: updateValues,
            onProgress: reportMappingRebuildProgress,
          });
          indexRebuilt = {
            version: rebuildResult.build.version,
            stats: rebuildResult.stats,
          };
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
          .update(catalogConfig)
          .set(updateValues)
          .where(eq(catalogConfig.id, input.catalogConfigId));
      }

      if (config.origin === "api") {
        await db
          .update(catalogSyncConfig)
          .set({
            name: input.name ?? config.name,
            experienceId:
              experienceId !== undefined ? experienceId : config.experienceId,
            enabled: input.enabled ?? config.enabled,
            stableKeyField: input.stableKeyField ?? config.stableKeyField,
            updatedAtField:
              input.updatedAtField !== undefined
                ? input.updatedAtField || null
                : config.updatedAtField,
            deletionField:
              input.deletionField !== undefined
                ? input.deletionField || null
                : config.deletionField,
            deletionInactiveValues:
              input.deletionInactiveValues ?? config.deletionInactiveValues,
            titleField: input.titleField ?? config.titleField,
            searchableFields: input.searchableFields ?? config.searchableFields,
            exactMatchFields: input.exactMatchFields ?? config.exactMatchFields,
            updatedAt: new Date(),
          })
          .where(eq(catalogSyncConfig.catalogConfigId, config.id));
      }

      if (experienceId !== undefined) {
        await replaceExperienceLink(config.knowledgeSourceId, experienceId);
      }

      await audit(
        ctx,
        "knowledge.catalog.updated",
        { type: "knowledge_source", id: config.knowledgeSourceId },
        {
          catalogConfigId: input.catalogConfigId,
          ...(indexRebuilt ? { indexRebuilt } : {}),
        },
      );

      return { success: true, indexRebuilt };
    }),

  rebuildFacts: protectedProcedure
    .input(z.object({ catalogConfigId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const config = await loadCatalogImportConfigById(input.catalogConfigId);
      if (!config) throw new Error("Catalog config not found");
      await requireAgent(config.agentId);

      const result = await rebuildCatalogFactsForSource({ config });
      await audit(
        ctx,
        "knowledge.catalog.facts_rebuilt",
        { type: "knowledge_source", id: config.knowledgeSourceId },
        { catalogConfigId: input.catalogConfigId, ...result },
      );

      return { success: true, ...result };
    }),

  csvUploadStart: protectedProcedure
    .input(
      catalogMappingInput.extend({
        agentId: z.string(),
        fileName: z.string(),
        mime: z.string(),
        bytes: z
          .number()
          .max(
            MAX_KNOWLEDGE_FILE_SIZE,
            `File exceeds maximum size of ${MAX_KNOWLEDGE_FILE_SIZE / (1024 * 1024)}MB`,
          ),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await requireAgent(input.agentId);
      const experienceId = await validateExperience(
        input.agentId,
        input.experienceId,
      );

      const sourceId = nanoid();
      const catalogConfigId = nanoid();
      const r2Key = `agents/${input.agentId}/catalogs/${sourceId}/${input.fileName}`;
      const now = new Date();
      const { env } = await import("cloudflare:workers");
      const r2Bucket = getR2BucketName(env);

      await db.insert(knowledgeSource).values({
        id: sourceId,
        agentId: input.agentId,
        type: "dataset",
        r2Bucket,
        r2Key,
        fileName: input.fileName,
        mime: input.mime || "text/csv",
        bytes: input.bytes,
        status: "uploaded",
        progress: 0,
        progressMessage: "CSV catalog upload configured",
        parserErrors: [],
        vectorizeIds: [],
        createdAt: now,
        updatedAt: now,
      });

      await db.insert(catalogConfig).values({
        id: catalogConfigId,
        agentId: input.agentId,
        knowledgeSourceId: sourceId,
        experienceId,
        name: input.name,
        scopeName: input.scopeName || null,
        scopeAliases: input.scopeAliases,
        origin: "csv",
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

      if (experienceId) {
        await replaceExperienceLink(sourceId, experienceId);
      }

      const aws = new AwsClient({
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      });
      const url = createR2ObjectUrl(env, r2Key);
      url.searchParams.set("X-Amz-Expires", "3600");
      const signedRequest = await aws.sign(
        new Request(url, { method: "PUT" }),
        {
          aws: { signQuery: true },
        },
      );

      await audit(
        ctx,
        "knowledge.catalog_csv.created",
        { type: "knowledge_source", id: sourceId },
        { catalogConfigId, name: input.name, experienceId },
      );

      return {
        sourceId,
        catalogConfigId,
        uploadUrl: signedRequest.url,
        uploadMethod: "presigned",
      };
    }),

  csvConfirm: protectedProcedure
    .input(z.object({ sourceId: z.string(), checksum: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      const config = await loadCatalogImportConfigBySourceIdForAuth(
        input.sourceId,
      );
      if (config.origin !== "csv") {
        throw new Error("Only CSV catalog sources can be confirmed here");
      }

      await db
        .update(knowledgeSource)
        .set({
          status: "uploaded",
          checksum: input.checksum,
          progress: 0,
          progressMessage: "CSV catalog uploaded",
          parserErrors: [],
          updatedAt: new Date(),
        })
        .where(eq(knowledgeSource.id, input.sourceId));

      await audit(
        ctx,
        "knowledge.catalog_csv.uploaded",
        { type: "knowledge_source", id: input.sourceId },
        { catalogConfigId: config.id },
      );

      return { success: true };
    }),

  csvIndex: protectedProcedure
    .input(
      z.object({
        sourceId: z.string(),
        content: z.string().optional(),
        contentBuffer: z.instanceof(Uint8Array).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const config = await loadCatalogImportConfigBySourceIdForAuth(
        input.sourceId,
      );
      if (config.origin !== "csv") {
        throw new Error("Only CSV catalog sources can be indexed here");
      }
      const { env } = await import("cloudflare:workers");

      try {
        const result = await processCsvCatalogSource({
          sourceId: input.sourceId,
          env,
          content: input.content ?? input.contentBuffer,
          abortSignal: ctx.request.signal,
        });
        await audit(
          ctx,
          "knowledge.catalog_csv.indexed",
          { type: "knowledge_source", id: input.sourceId },
          { catalogConfigId: config.id, ...result },
        );
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await db
          .update(knowledgeSource)
          .set({
            status: "failed",
            progressMessage: `CSV catalog import failed: ${message}`,
            parserErrors: [message],
            updatedAt: new Date(),
          })
          .where(eq(knowledgeSource.id, input.sourceId));
        throw new Error(`CSV catalog import failed: ${message}`);
      }
    }),

  csvReimport: protectedProcedure
    .input(z.object({ sourceId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const config = await loadCatalogImportConfigBySourceIdForAuth(
        input.sourceId,
      );
      if (config.origin !== "csv") {
        throw new Error("Only CSV catalog sources can be re-imported here");
      }
      const { env } = await import("cloudflare:workers");
      try {
        const result = await processCsvCatalogSource({
          sourceId: input.sourceId,
          env,
          abortSignal: ctx.request.signal,
        });

        await audit(
          ctx,
          "knowledge.catalog_csv.reimported",
          { type: "knowledge_source", id: input.sourceId },
          { catalogConfigId: config.id, ...result },
        );

        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await db
          .update(knowledgeSource)
          .set({
            status: "failed",
            progressMessage: `CSV catalog re-import failed: ${message}`,
            parserErrors: [message],
            updatedAt: new Date(),
          })
          .where(eq(knowledgeSource.id, input.sourceId));
        throw new Error(`CSV catalog re-import failed: ${message}`);
      }
    }),
});

async function loadCatalogImportConfigBySourceIdForAuth(sourceId: string) {
  const [config] = await db
    .select()
    .from(catalogConfig)
    .where(eq(catalogConfig.knowledgeSourceId, sourceId))
    .limit(1);

  if (!config) throw new Error("Catalog config not found");
  await requireAgent(config.agentId);
  return config;
}

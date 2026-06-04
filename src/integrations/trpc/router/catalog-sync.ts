import { and, count, desc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "@/db";
import {
  agentExperience,
  agentExperienceKnowledge,
  catalogProduct,
  catalogSyncConfig,
  catalogSyncRun,
  knowledgeSource,
} from "@/db/schema";
import { audit, requireAgent } from "@/integrations/trpc/helpers";
import { createTRPCRouter, protectedProcedure } from "@/integrations/trpc/init";
import {
  type CatalogSyncMode,
  computeNextCatalogRunAt,
} from "@/lib/catalog/sync";

const catalogFieldListSchema = z.array(z.string().trim().min(1)).default([]);
const DEFAULT_UPDATED_SINCE_PARAM = "effectiveUpdatedAfter";

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
  syncIntervalDays: z.number().int().min(1).max(31).default(7),
  scheduleWeekdayUtc: z.number().int().min(0).max(6).default(1),
  scheduleHourUtc: z.number().int().min(0).max(23).default(3),
  enabled: z.boolean().default(true),
});

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

export const catalogSyncRouter = createTRPCRouter({
  list: protectedProcedure
    .input(z.object({ agentId: z.string() }))
    .query(async ({ input }) => {
      await requireAgent(input.agentId);

      const rows = await db
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
          sourceStatus: knowledgeSource.status,
          sourceProgress: knowledgeSource.progress,
          sourceProgressMessage: knowledgeSource.progressMessage,
        })
        .from(catalogSyncConfig)
        .innerJoin(
          knowledgeSource,
          eq(knowledgeSource.id, catalogSyncConfig.knowledgeSourceId),
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
        .where(inArray(catalogProduct.sourceId, sourceIds))
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
      const config = await requireCatalogConfig(input.configId);
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

      await db.insert(catalogSyncConfig).values({
        id: configId,
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

      return { configId, sourceId };
    }),

  update: protectedProcedure
    .input(catalogConfigInput.partial().extend({ configId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const config = await requireCatalogConfig(input.configId);
      const experienceId =
        input.experienceId !== undefined
          ? await validateExperience(config.agentId, input.experienceId)
          : undefined;

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

      await db
        .update(catalogSyncConfig)
        .set(updateValues)
        .where(eq(catalogSyncConfig.id, input.configId));

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
        { configId: input.configId },
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

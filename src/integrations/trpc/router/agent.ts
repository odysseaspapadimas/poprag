import { and, desc, eq, or, type SQL, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "@/db";
import {
  agent,
  agentIndexPin,
  agentModelPolicy,
  auditLog,
  type InsertAgent,
  knowledgeSource,
  modelAlias,
  prompt,
  promptVersion,
  runMetric,
  transcript,
  user,
} from "@/db/schema";
import { audit, requireAgent } from "@/integrations/trpc/helpers";
import { createTRPCRouter, protectedProcedure } from "@/integrations/trpc/init";

/**
 * Agent management router
 */
export const agentRouter = createTRPCRouter({
  /**
   * List all agents (with pagination and filtering)
   */
  list: protectedProcedure
    .input(
      z
        .object({
          status: z.enum(["draft", "active", "archived"]).optional(),
          visibility: z.enum(["private", "public"]).optional(),
          search: z.string().optional(),
          limit: z.number().min(1).max(100).default(50),
          offset: z.number().min(0).default(0),
        })
        .optional(),
    )
    .query(async ({ input, ctx }) => {
      const conditions = [];

      if (input?.status) {
        conditions.push(eq(agent.status, input.status));
      }

      if (input?.visibility) {
        conditions.push(eq(agent.visibility, input.visibility));
      }

      // Visibility enforcement: show public agents OR private agents owned by user
      conditions.push(
        or(
          eq(agent.visibility, "public"),
          and(
            eq(agent.visibility, "private"),
            eq(agent.createdBy, ctx.session.user.id),
          ),
        ),
      );

      const agents = await db
        .select()
        .from(agent)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(agent.createdAt))
        .limit(input?.limit || 50)
        .offset(input?.offset || 0);

      return agents;
    }),

  /**
   * Get agent by ID or slug
   */
  get: protectedProcedure
    .input(
      z.object({
        id: z.string().optional(),
        slug: z.string().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      if (!input.id && !input.slug) {
        throw new Error("Must provide either id or slug");
      }

      const idOrSlugCondition = input.id
        ? eq(agent.id, input.id)
        : eq(agent.slug, input.slug!);

      // Visibility enforcement: allow if public OR private and owned by user
      const visibilityCondition = or(
        eq(agent.visibility, "public"),
        and(
          eq(agent.visibility, "private"),
          eq(agent.createdBy, ctx.session.user.id),
        ),
      );

      const [result] = await db
        .select()
        .from(agent)
        .where(and(idOrSlugCondition, visibilityCondition))
        .limit(1);

      if (!result) {
        // Return null so the UI can show a friendly 'not found' message instead of throwing an error
        return null;
      }

      return result;
    }),

  /**
   * Create new agent
   */
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        slug: z
          .string()
          .min(1)
          .max(50)
          .regex(/^[a-z0-9-]+$/),
        description: z.string().optional(),
        visibility: z.enum(["private", "public"]).default("private"),
        modelAlias: z.string(),
        systemPrompt: z.string().optional(),
        ragEnabled: z.boolean().default(true),
        skipIntentClassification: z.boolean().default(true),
        rewriteQuery: z.boolean().default(false),
        rewriteModel: z.string().optional(),
        intentModel: z.string().optional(),
        queryVariationsCount: z.number().min(1).max(10).optional(),
        rerank: z.boolean().default(false),
        rerankModel: z.string().optional(),
        topK: z.number().min(1).max(20).optional(),
        minSimilarity: z.number().min(0).max(100).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const agentId = nanoid();
      const promptId = nanoid();
      const promptVersionId = nanoid();
      const policyId = nanoid();

      // Check if slug is unique
      const [existing] = await db
        .select()
        .from(agent)
        .where(eq(agent.slug, input.slug))
        .limit(1);

      if (existing) {
        throw new Error("Agent slug already exists");
      }

      // Verify model alias exists
      const [model] = await db
        .select()
        .from(modelAlias)
        .where(eq(modelAlias.alias, input.modelAlias))
        .limit(1);

      if (!model) {
        throw new Error("Model alias not found");
      }

      // Create agent
      await db.insert(agent).values({
        id: agentId,
        name: input.name,
        slug: input.slug,
        description: input.description || null,
        visibility: input.visibility,
        status: "draft",
        ragEnabled: input.ragEnabled,
        skipIntentClassification: input.skipIntentClassification,
        rewriteQuery: input.rewriteQuery,
        rewriteModel: input.rewriteModel,
        intentModel: input.intentModel,
        queryVariationsCount: input.queryVariationsCount,
        rerank: input.rerank,
        rerankModel: input.rerankModel,
        topK: input.topK || 5,
        minSimilarity: input.minSimilarity || 15,
        createdBy: ctx.session.user.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Create default system prompt
      await db.insert(prompt).values({
        id: promptId,
        agentId: agentId,
        key: "system",
        description: "System prompt",
      });

      // Create first prompt version
      await db.insert(promptVersion).values({
        id: promptVersionId,
        promptId: promptId,
        version: 1,
        label: "dev",
        content:
          input.systemPrompt ||
          "You are a helpful AI assistant. Answer questions accurately and concisely.",
        variables: {},
        createdBy: ctx.session.user.id,
        createdAt: new Date(),
      });

      // Create model policy
      await db.insert(agentModelPolicy).values({
        id: policyId,
        agentId: agentId,
        modelAlias: input.modelAlias,
        temperature: 0.2,
        topP: 0.8,
        maxTokens: 4096,
        effectiveFrom: new Date(),
      });

      // Audit log
      await audit(
        ctx,
        "agent.created",
        { type: "agent", id: agentId },
        {
          name: input.name,
          slug: input.slug,
        },
      );

      return { id: agentId, slug: input.slug };
    }),

  /**
   * Update agent
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(100).optional(),
        description: z.string().optional(),
        status: z.enum(["draft", "active", "archived"]).optional(),
        visibility: z.enum(["private", "public"]).optional(),
        ragEnabled: z.boolean().optional(),
        skipIntentClassification: z.boolean().optional(),
        rewriteQuery: z.boolean().optional(),
        rewriteModel: z.string().optional(),
        intentModel: z.string().optional(),
        queryVariationsCount: z.number().min(1).max(10).optional(),
        rerank: z.boolean().optional(),
        rerankModel: z.string().optional(),
        topK: z.number().min(1).max(20).optional(),
        minSimilarity: z.number().min(0).max(100).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await requireAgent(input.id);

      const updates: Partial<InsertAgent> = {
        updatedAt: new Date(),
      };

      if (input.name) updates.name = input.name;
      if (input.description !== undefined)
        updates.description = input.description;
      if (input.status) updates.status = input.status;
      if (input.visibility) updates.visibility = input.visibility;
      if (input.ragEnabled !== undefined) updates.ragEnabled = input.ragEnabled;
      if (input.skipIntentClassification !== undefined)
        updates.skipIntentClassification = input.skipIntentClassification;
      if (input.rewriteQuery !== undefined)
        updates.rewriteQuery = input.rewriteQuery;
      if (input.rewriteModel !== undefined)
        updates.rewriteModel = input.rewriteModel;
      if (input.intentModel !== undefined)
        updates.intentModel = input.intentModel;
      if (input.queryVariationsCount !== undefined)
        updates.queryVariationsCount = input.queryVariationsCount;
      if (input.rerank !== undefined) updates.rerank = input.rerank;
      if (input.rerankModel !== undefined)
        updates.rerankModel = input.rerankModel;
      if (input.topK !== undefined) updates.topK = input.topK;
      if (input.minSimilarity !== undefined)
        updates.minSimilarity = input.minSimilarity;

      await db.update(agent).set(updates).where(eq(agent.id, input.id));

      // Audit log
      await audit(
        ctx,
        "agent.updated",
        { type: "agent", id: input.id },
        updates,
      );

      return { success: true };
    }),

  /**
   * Archive agent
   */
  archive: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await requireAgent(input.id);

      await db
        .update(agent)
        .set({ status: "archived", updatedAt: new Date() })
        .where(eq(agent.id, input.id));

      await audit(
        ctx,
        "agent.archived",
        { type: "agent", id: input.id },
        {
          status: "archived",
        },
      );

      return { success: true };
    }),

  /**
   * Permanently delete agent
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await requireAgent(input.id);

      await db.delete(agent).where(eq(agent.id, input.id));

      // Audit log
      await audit(
        ctx,
        "agent.deleted",
        { type: "agent", id: input.id },
        {
          deleted: true,
        },
      );

      return { success: true };
    }),

  /**
   * Get agent's knowledge sources
   */
  getKnowledgeSources: protectedProcedure
    .input(z.object({ agentId: z.string() }))
    .query(async ({ input }) => {
      return await db
        .select()
        .from(knowledgeSource)
        .where(eq(knowledgeSource.agentId, input.agentId))
        .orderBy(desc(knowledgeSource.createdAt));
    }),

  /**
   * Get agent's current index pin
   */
  getIndexPin: protectedProcedure
    .input(z.object({ agentId: z.string() }))
    .query(async ({ input }) => {
      const [pin] = await db
        .select()
        .from(agentIndexPin)
        .where(eq(agentIndexPin.agentId, input.agentId))
        .limit(1);

      return pin || null;
    }),

  /**
   * Pin index version for agent
   */
  pinIndexVersion: protectedProcedure
    .input(
      z.object({
        agentId: z.string(),
        indexVersion: z.number(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // Check if pin exists
      const [existing] = await db
        .select()
        .from(agentIndexPin)
        .where(eq(agentIndexPin.agentId, input.agentId))
        .limit(1);

      if (existing) {
        // Update existing pin
        await db
          .update(agentIndexPin)
          .set({
            indexVersion: input.indexVersion,
            pinnedAt: new Date(),
            pinnedBy: ctx.session.user.id,
          })
          .where(eq(agentIndexPin.agentId, input.agentId));
      } else {
        // Create new pin
        await db.insert(agentIndexPin).values({
          id: nanoid(),
          agentId: input.agentId,
          indexVersion: input.indexVersion,
          pinnedAt: new Date(),
          pinnedBy: ctx.session.user.id,
        });
      }

      // Audit log
      await audit(
        ctx,
        "agent.index_pinned",
        { type: "agent", id: input.agentId },
        {
          indexVersion: input.indexVersion,
        },
      );

      return { success: true };
    }),

  /**
   * Get audit log for agent
   */
  getAuditLog: protectedProcedure
    .input(
      z.object({
        agentId: z.string(),
        limit: z.number().min(1).max(100).default(50),
      }),
    )
    .query(async ({ input }) => {
      // Get audit logs for the agent itself
      const agentLogs = await db
        .select({
          id: auditLog.id,
          actorId: auditLog.actorId,
          actorName: user.name,
          actorEmail: user.email,
          eventType: auditLog.eventType,
          targetType: auditLog.targetType,
          targetId: auditLog.targetId,
          diff: auditLog.diff,
          createdAt: auditLog.createdAt,
        })
        .from(auditLog)
        .innerJoin(user, eq(auditLog.actorId, user.id))
        .where(
          and(
            eq(auditLog.targetType, "agent"),
            eq(auditLog.targetId, input.agentId),
          ),
        );

      // Get audit logs for knowledge sources belonging to this agent
      const knowledgeLogs = await db
        .select({
          id: auditLog.id,
          actorId: auditLog.actorId,
          actorName: user.name,
          actorEmail: user.email,
          eventType: auditLog.eventType,
          targetType: auditLog.targetType,
          targetId: auditLog.targetId,
          diff: auditLog.diff,
          createdAt: auditLog.createdAt,
        })
        .from(auditLog)
        .innerJoin(user, eq(auditLog.actorId, user.id))
        .innerJoin(knowledgeSource, eq(auditLog.targetId, knowledgeSource.id))
        .where(
          and(
            eq(auditLog.targetType, "knowledge_source"),
            eq(knowledgeSource.agentId, input.agentId),
          ),
        );

      // Get audit logs for prompts belonging to this agent
      const promptLogs = await db
        .select({
          id: auditLog.id,
          actorId: auditLog.actorId,
          actorName: user.name,
          actorEmail: user.email,
          eventType: auditLog.eventType,
          targetType: auditLog.targetType,
          targetId: auditLog.targetId,
          diff: auditLog.diff,
          createdAt: auditLog.createdAt,
        })
        .from(auditLog)
        .innerJoin(user, eq(auditLog.actorId, user.id))
        .innerJoin(prompt, eq(auditLog.targetId, prompt.id))
        .where(
          and(
            eq(auditLog.targetType, "prompt"),
            eq(prompt.agentId, input.agentId),
          ),
        );

      // Combine and sort all logs
      const allLogs = [...agentLogs, ...knowledgeLogs, ...promptLogs]
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        )
        .slice(0, input.limit);

      return allLogs;
    }),

  /**
   * Get run metrics for an agent
   */
  getRunMetrics: protectedProcedure
    .input(
      z.object({
        agentId: z.string(),
        limit: z.number().min(1).max(10000).optional(),
        sinceMs: z.number().optional(),
      }),
    )
    .query(async ({ input }) => {
      const conditions: SQL[] = [eq(runMetric.agentId, input.agentId)];
      if (input.sinceMs) {
        conditions.push(sql`${runMetric.createdAt} >= ${input.sinceMs}`);
      }

      const query = db
        .select({
          id: runMetric.id,
          agentId: runMetric.agentId,
          runId: runMetric.runId,
          conversationId: sql<
            string | null
          >`coalesce(${runMetric.conversationId}, ${transcript.conversationId})`,
          initiatedBy: sql<
            string | null
          >`coalesce(${runMetric.initiatedBy}, ${transcript.initiatedBy})`,
          initiatedByName: user.name,
          initiatedByEmail: user.email,
          modelAlias: runMetric.modelAlias,
          promptTokens: runMetric.promptTokens,
          completionTokens: runMetric.completionTokens,
          totalTokens: runMetric.totalTokens,
          tokens: runMetric.tokens,
          costMicrocents: runMetric.costMicrocents,
          latencyMs: runMetric.latencyMs,
          timeToFirstTokenMs: runMetric.timeToFirstTokenMs,
          errorType: runMetric.errorType,
          createdAt: runMetric.createdAt,
          request: transcript.request,
          response: transcript.response,
        })
        .from(runMetric)
        .leftJoin(transcript, eq(transcript.runId, runMetric.runId))
        .leftJoin(
          user,
          or(
            eq(user.id, runMetric.initiatedBy),
            eq(user.id, transcript.initiatedBy),
          ),
        )
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(runMetric.createdAt));

      // Apply limit if specified, otherwise return all matching rows
      if (input.limit) {
        return await query.limit(input.limit);
      }
      return await query;
    }),

  /**
   * Update agent model policy
   */
  updateModelPolicy: protectedProcedure
    .input(
      z.object({
        agentId: z.string(),
        modelAlias: z.string().optional(),
        temperature: z.number().min(0).max(2).optional(),
        topP: z.number().min(0).max(1).optional(),
        maxTokens: z.number().min(1).max(32000).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await requireAgent(input.agentId);

      // Get current policy
      const [currentPolicy] = await db
        .select()
        .from(agentModelPolicy)
        .where(eq(agentModelPolicy.agentId, input.agentId))
        .orderBy(desc(agentModelPolicy.effectiveFrom))
        .limit(1);

      if (!currentPolicy) {
        throw new Error("Model policy not found");
      }

      // Update policy
      const updates: any = {};
      // Validate modelAlias existence if provided
      if (input.modelAlias !== undefined) {
        const [alias] = await db
          .select()
          .from(modelAlias)
          .where(eq(modelAlias.alias, input.modelAlias))
          .limit(1);
        if (!alias) {
          throw new Error("Model alias not found");
        }
        updates.modelAlias = input.modelAlias;
      }
      if (input.temperature !== undefined)
        updates.temperature = input.temperature;
      if (input.topP !== undefined) updates.topP = input.topP;
      if (input.maxTokens !== undefined) updates.maxTokens = input.maxTokens;

      await db
        .update(agentModelPolicy)
        .set(updates)
        .where(eq(agentModelPolicy.id, currentPolicy.id));

      // Audit log
      await audit(
        ctx,
        "agent.policy_updated",
        { type: "agent", id: input.agentId },
        updates,
      );

      return { success: true };
    }),

  /**
   * Get current model policy for an agent (latest effectiveFrom)
   */
  getModelPolicy: protectedProcedure
    .input(
      z.object({
        agentId: z.string(),
      }),
    )
    .query(async ({ input }) => {
      const [policy] = await db
        .select()
        .from(agentModelPolicy)
        .where(eq(agentModelPolicy.agentId, input.agentId))
        .orderBy(desc(agentModelPolicy.effectiveFrom))
        .limit(1);

      return policy || null;
    }),

  /**
   * Get a quick setup status for the UI. Returns booleans that indicate
   * whether the agent has a production prompt and whether a model alias is set.
   */
  getSetupStatus: protectedProcedure
    .input(z.object({ agentId: z.string() }))
    .query(async ({ input }) => {
      // Check agent status
      const [agentData] = await db
        .select()
        .from(agent)
        .where(eq(agent.id, input.agentId))
        .limit(1);

      const isActive = agentData?.status === "active";

      // Check for a model policy with a modelAlias
      const [policy] = await db
        .select()
        .from(agentModelPolicy)
        .where(eq(agentModelPolicy.agentId, input.agentId))
        .orderBy(desc(agentModelPolicy.effectiveFrom))
        .limit(1);

      const hasModelAlias = !!(policy && policy.modelAlias);

      // Check if any prompt has a 'prod' labeled version
      const [prodPromptVersion] = await db
        .select()
        .from(promptVersion)
        .innerJoin(prompt, eq(prompt.id, promptVersion.promptId))
        .where(
          and(
            eq(promptVersion.label, "prod"),
            eq(prompt.agentId, input.agentId),
          ),
        )
        .limit(1);

      const hasProdPrompt = !!prodPromptVersion;

      return {
        hasModelAlias,
        hasProdPrompt,
        isActive,
        modelAlias: policy?.modelAlias || null, // Include the actual alias for capability checks
      };
    }),
});

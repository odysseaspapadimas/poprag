import { db } from "@/db";
import {
  agent,
  agentIndexPin,
  agentModelPolicy,
  auditLog,
  knowledgeSource,
  modelAlias,
  prompt,
  promptVersion,
  runMetric,
  type InsertAgent,
} from "@/db/schema";
import { createTRPCRouter, protectedProcedure } from "@/integrations/trpc/init";
import { and, desc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";

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
          visibility: z.enum(["private", "workspace", "public"]).optional(),
          search: z.string().optional(),
          limit: z.number().min(1).max(100).default(50),
          offset: z.number().min(0).default(0),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      const conditions = [];

      if (input?.status) {
        conditions.push(eq(agent.status, input.status));
      }

      if (input?.visibility) {
        conditions.push(eq(agent.visibility, input.visibility));
      }

      // Basic RBAC: only show user's own agents unless admin
      if (!ctx.session.user.isAdmin) {
        conditions.push(eq(agent.createdBy, ctx.session.user.id));
      }

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
      })
    )
    .query(async ({ input, ctx }) => {
      if (!input.id && !input.slug) {
        throw new Error("Must provide either id or slug");
      }

      const [result] = await db
        .select()
        .from(agent)
        .where(input.id ? eq(agent.id, input.id) : eq(agent.slug, input.slug!))
        .limit(1);

      if (!result) {
        // Return null so the UI can show a friendly 'not found' message instead of throwing an error
        return null;
      }

      // Check permissions
      if (
        !ctx.session.user.isAdmin &&
        result.createdBy !== ctx.session.user.id
      ) {
        if (result.visibility === "private") {
          throw new Error("Access denied");
        }
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
        visibility: z
          .enum(["private", "workspace", "public"])
          .default("private"),
        modelAlias: z.string(),
        systemPrompt: z.string().optional(),
      })
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

      // Create model policy with RAG enabled by default
      await db.insert(agentModelPolicy).values({
        id: policyId,
        agentId: agentId,
        modelAlias: input.modelAlias,
        temperature: 0.7,
        topP: 1,
        maxTokens: 2048,
        enabledTools: ["retrieval"], // Enable RAG by default
        effectiveFrom: new Date(),
      });

      // Audit log
      await db.insert(auditLog).values({
        id: nanoid(),
        actorId: ctx.session.user.id,
        eventType: "agent.created",
        targetType: "agent",
        targetId: agentId,
        diff: { name: input.name, slug: input.slug },
        createdAt: new Date(),
      });

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
        visibility: z.enum(["private", "workspace", "public"]).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Check permissions
      const [existing] = await db
        .select()
        .from(agent)
        .where(eq(agent.id, input.id))
        .limit(1);

      if (!existing) {
        throw new Error("Agent not found");
      }

      if (
        !ctx.session.user.isAdmin &&
        existing.createdBy !== ctx.session.user.id
      ) {
        throw new Error("Access denied");
      }

      const updates: Partial<InsertAgent> = {
        updatedAt: new Date(),
      };

      if (input.name) updates.name = input.name;
      if (input.description !== undefined)
        updates.description = input.description;
      if (input.status) updates.status = input.status;
      if (input.visibility) updates.visibility = input.visibility;

      await db.update(agent).set(updates).where(eq(agent.id, input.id));

      // Audit log
      await db.insert(auditLog).values({
        id: nanoid(),
        actorId: ctx.session.user.id,
        eventType: "agent.updated",
        targetType: "agent",
        targetId: input.id,
        diff: updates,
        createdAt: new Date(),
      });

      return { success: true };
    }),

  /**
   * Archive agent
   */
  archive: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const [existing] = await db
        .select()
        .from(agent)
        .where(eq(agent.id, input.id))
        .limit(1);

      if (!existing) {
        throw new Error("Agent not found");
      }

      if (
        !ctx.session.user.isAdmin &&
        existing.createdBy !== ctx.session.user.id
      ) {
        throw new Error("Access denied");
      }

      await db
        .update(agent)
        .set({ status: "archived", updatedAt: new Date() })
        .where(eq(agent.id, input.id));

      await db.insert(auditLog).values({
        id: nanoid(),
        actorId: ctx.session.user.id,
        eventType: "agent.archived",
        targetType: "agent",
        targetId: input.id,
        diff: { status: "archived" },
        createdAt: new Date(),
      });

      return { success: true };
    }),

  /**
   * Permanently delete agent
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const [existing] = await db
        .select()
        .from(agent)
        .where(eq(agent.id, input.id))
        .limit(1);

      if (!existing) {
        throw new Error("Agent not found");
      }

      if (
        !ctx.session.user.isAdmin &&
        existing.createdBy !== ctx.session.user.id
      ) {
        throw new Error("Access denied");
      }

      // Only allow deletion of archived agents
      if (existing.status !== "archived") {
        throw new Error("Only archived agents can be permanently deleted");
      }

      await db.delete(agent).where(eq(agent.id, input.id));

      // Audit log
      await db.insert(auditLog).values({
        id: nanoid(),
        actorId: ctx.session.user.id,
        eventType: "agent.deleted",
        targetType: "agent",
        targetId: input.id,
        diff: { deleted: true },
        createdAt: new Date(),
      });

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
      })
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
      await db.insert(auditLog).values({
        id: nanoid(),
        actorId: ctx.session.user.id,
        eventType: "agent.index_pinned",
        targetType: "agent",
        targetId: input.agentId,
        diff: { indexVersion: input.indexVersion },
        createdAt: new Date(),
      });

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
      })
    )
    .query(async ({ input }) => {
      return await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.targetType, "agent"),
            eq(auditLog.targetId, input.agentId)
          )
        )
        .orderBy(desc(auditLog.createdAt))
        .limit(input.limit);
    }),

  /**
   * Get run metrics for an agent
   */
  getRunMetrics: protectedProcedure
    .input(
      z.object({
        agentId: z.string(),
        limit: z.number().min(1).max(100).default(50),
        sinceMs: z.number().optional(),
      })
    )
    .query(async ({ input }) => {
      const conditions: any[] = [eq(runMetric.agentId, input.agentId)];
      if (input.sinceMs) {
        conditions.push(sql`${runMetric.createdAt} >= ${input.sinceMs}`);
      }

      return await db
        .select()
        .from(runMetric)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(runMetric.createdAt))
        .limit(input.limit);
    }),

  /**
   * Update agent model policy
   */
  updateModelPolicy: protectedProcedure
    .input(
      z.object({
        agentId: z.string(),
        modelAlias: z.string().optional(),
        enabledTools: z.array(z.string()).optional(),
        temperature: z.number().min(0).max(2).optional(),
        topP: z.number().min(0).max(1).optional(),
        maxTokens: z.number().min(1).max(32000).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Verify agent exists and user has access
      const [agentData] = await db
        .select()
        .from(agent)
        .where(eq(agent.id, input.agentId))
        .limit(1);

      if (!agentData) {
        throw new Error("Agent not found");
      }

      if (
        !ctx.session.user.isAdmin &&
        agentData.createdBy !== ctx.session.user.id
      ) {
        throw new Error("Access denied");
      }

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
      if (input.enabledTools !== undefined)
        updates.enabledTools = input.enabledTools;
      if (input.temperature !== undefined)
        updates.temperature = input.temperature;
      if (input.topP !== undefined) updates.topP = input.topP;
      if (input.maxTokens !== undefined) updates.maxTokens = input.maxTokens;

      await db
        .update(agentModelPolicy)
        .set(updates)
        .where(eq(agentModelPolicy.id, currentPolicy.id));

      // Audit log
      await db.insert(auditLog).values({
        id: nanoid(),
        actorId: ctx.session.user.id,
        eventType: "agent.policy_updated",
        targetType: "agent",
        targetId: input.agentId,
        diff: updates,
        createdAt: new Date(),
      });

      return { success: true };
    }),

  /**
   * Get current model policy for an agent (latest effectiveFrom)
   */
  getModelPolicy: protectedProcedure
    .input(
      z.object({
        agentId: z.string(),
      })
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
            eq(prompt.agentId, input.agentId)
          )
        )
        .limit(1);

      const hasProdPrompt = !!prodPromptVersion;

      return { hasModelAlias, hasProdPrompt };
    }),
});

/**
 * Experience (Knowledge Group) management router
 * Allows grouping knowledge sources into named experiences under an agent
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "@/db";
import {
  agentExperience,
  agentExperienceKnowledge,
  knowledgeSource,
} from "@/db/schema";
import { audit, requireAgent } from "@/integrations/trpc/helpers";
import { createTRPCRouter, protectedProcedure } from "@/integrations/trpc/init";

/**
 * Generate a URL-safe slug from a name
 */
function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "") // Remove non-word chars (except spaces and hyphens)
    .replace(/[\s_]+/g, "-") // Replace spaces/underscores with hyphens
    .replace(/-+/g, "-") // Collapse multiple hyphens
    .replace(/^-|-$/g, ""); // Trim leading/trailing hyphens
}

export const experienceRouter = createTRPCRouter({
  /**
   * List all experiences for an agent (with knowledge source counts)
   */
  list: protectedProcedure
    .input(z.object({ agentId: z.string() }))
    .query(async ({ input }) => {
      await requireAgent(input.agentId);

      const experiences = await db
        .select()
        .from(agentExperience)
        .where(eq(agentExperience.agentId, input.agentId))
        .orderBy(asc(agentExperience.order), asc(agentExperience.createdAt));

      if (experiences.length === 0) return [];

      // Fetch knowledge counts for all experiences in one query
      const knowledgeLinks = await db
        .select()
        .from(agentExperienceKnowledge)
        .where(
          inArray(
            agentExperienceKnowledge.experienceId,
            experiences.map((e) => e.id),
          ),
        );

      // Build count map
      const countMap = new Map<string, number>();
      for (const link of knowledgeLinks) {
        countMap.set(
          link.experienceId,
          (countMap.get(link.experienceId) || 0) + 1,
        );
      }

      return experiences.map((exp) => ({
        ...exp,
        knowledgeSourceCount: countMap.get(exp.id) || 0,
      }));
    }),

  /**
   * Get a single experience with its assigned knowledge source IDs
   */
  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const [experience] = await db
        .select()
        .from(agentExperience)
        .where(eq(agentExperience.id, input.id))
        .limit(1);

      if (!experience) {
        throw new Error("Experience not found");
      }

      const knowledgeLinks = await db
        .select({
          knowledgeSourceId: agentExperienceKnowledge.knowledgeSourceId,
        })
        .from(agentExperienceKnowledge)
        .where(eq(agentExperienceKnowledge.experienceId, experience.id));

      return {
        ...experience,
        knowledgeSourceIds: knowledgeLinks.map(
          (link) => link.knowledgeSourceId,
        ),
      };
    }),

  /**
   * Create a new experience with knowledge source assignments
   */
  create: protectedProcedure
    .input(
      z.object({
        agentId: z.string(),
        name: z.string().min(1).max(200),
        slug: z.string().min(1).max(100).optional(),
        description: z.string().max(1000).optional(),
        order: z.number().int().min(0).optional(),
        isActive: z.boolean().optional(),
        knowledgeSourceIds: z.array(z.string()).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await requireAgent(input.agentId);

      const id = nanoid();
      const slug = input.slug || generateSlug(input.name);

      // Check for slug uniqueness within agent
      const [existing] = await db
        .select()
        .from(agentExperience)
        .where(
          and(
            eq(agentExperience.agentId, input.agentId),
            eq(agentExperience.slug, slug),
          ),
        )
        .limit(1);

      if (existing) {
        throw new Error(
          `Experience with slug '${slug}' already exists for this agent`,
        );
      }

      // Create experience
      await db.insert(agentExperience).values({
        id,
        agentId: input.agentId,
        slug,
        name: input.name,
        description: input.description ?? null,
        order: input.order ?? 0,
        isActive: input.isActive ?? true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Assign knowledge sources if provided
      if (input.knowledgeSourceIds && input.knowledgeSourceIds.length > 0) {
        await db.insert(agentExperienceKnowledge).values(
          input.knowledgeSourceIds.map((ksId) => ({
            experienceId: id,
            knowledgeSourceId: ksId,
          })),
        );
      }

      await audit(
        ctx,
        "agent.updated",
        {
          type: "agent",
          id: input.agentId,
        },
        {
          action: "experience.created",
          experienceId: id,
          experienceName: input.name,
          knowledgeSourceCount: input.knowledgeSourceIds?.length ?? 0,
        },
      );

      return { id, slug };
    }),

  /**
   * Update an experience (name, description, knowledge assignments, active status)
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(200).optional(),
        slug: z.string().min(1).max(100).optional(),
        description: z.string().max(1000).nullable().optional(),
        order: z.number().int().min(0).optional(),
        isActive: z.boolean().optional(),
        knowledgeSourceIds: z.array(z.string()).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const [experience] = await db
        .select()
        .from(agentExperience)
        .where(eq(agentExperience.id, input.id))
        .limit(1);

      if (!experience) {
        throw new Error("Experience not found");
      }

      // Check slug uniqueness if changing slug
      if (input.slug && input.slug !== experience.slug) {
        const [existing] = await db
          .select()
          .from(agentExperience)
          .where(
            and(
              eq(agentExperience.agentId, experience.agentId),
              eq(agentExperience.slug, input.slug),
            ),
          )
          .limit(1);

        if (existing) {
          throw new Error(
            `Experience with slug '${input.slug}' already exists for this agent`,
          );
        }
      }

      // Build update object
      const updates: Record<string, unknown> = {};
      if (input.name !== undefined) updates.name = input.name;
      if (input.slug !== undefined) updates.slug = input.slug;
      if (input.description !== undefined)
        updates.description = input.description;
      if (input.order !== undefined) updates.order = input.order;
      if (input.isActive !== undefined) updates.isActive = input.isActive;

      if (Object.keys(updates).length > 0) {
        await db
          .update(agentExperience)
          .set(updates)
          .where(eq(agentExperience.id, input.id));
      }

      // Update knowledge source assignments if provided
      if (input.knowledgeSourceIds !== undefined) {
        // Remove all existing assignments
        await db
          .delete(agentExperienceKnowledge)
          .where(eq(agentExperienceKnowledge.experienceId, input.id));

        // Insert new assignments
        if (input.knowledgeSourceIds.length > 0) {
          await db.insert(agentExperienceKnowledge).values(
            input.knowledgeSourceIds.map((ksId) => ({
              experienceId: input.id,
              knowledgeSourceId: ksId,
            })),
          );
        }
      }

      await audit(
        ctx,
        "agent.updated",
        {
          type: "agent",
          id: experience.agentId,
        },
        {
          action: "experience.updated",
          experienceId: input.id,
          changes: updates,
          knowledgeSourceCount: input.knowledgeSourceIds?.length,
        },
      );

      return { success: true };
    }),

  /**
   * Delete an experience (knowledge sources remain untouched)
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const [experience] = await db
        .select()
        .from(agentExperience)
        .where(eq(agentExperience.id, input.id))
        .limit(1);

      if (!experience) {
        throw new Error("Experience not found");
      }

      // Junction table entries are cascade-deleted
      await db.delete(agentExperience).where(eq(agentExperience.id, input.id));

      await audit(
        ctx,
        "agent.updated",
        {
          type: "agent",
          id: experience.agentId,
        },
        {
          action: "experience.deleted",
          experienceId: input.id,
          experienceName: experience.name,
        },
      );

      return { success: true };
    }),

  /**
   * Bulk create multiple experiences at once
   */
  bulkCreate: protectedProcedure
    .input(
      z.object({
        agentId: z.string(),
        experiences: z.array(
          z.object({
            name: z.string().min(1).max(200),
            slug: z.string().min(1).max(100).optional(),
            description: z.string().max(1000).optional(),
            knowledgeSourceIds: z.array(z.string()).optional(),
          }),
        ),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await requireAgent(input.agentId);

      const results: Array<{ id: string; slug: string; name: string }> = [];

      // Fetch existing slugs for this agent to avoid conflicts
      const existingSlugs = new Set(
        (
          await db
            .select({ slug: agentExperience.slug })
            .from(agentExperience)
            .where(eq(agentExperience.agentId, input.agentId))
        ).map((e) => e.slug),
      );

      // Get max order for ordering
      const existingExperiences = await db
        .select({ order: agentExperience.order })
        .from(agentExperience)
        .where(eq(agentExperience.agentId, input.agentId));
      let nextOrder =
        existingExperiences.length > 0
          ? Math.max(...existingExperiences.map((e) => e.order ?? 0)) + 1
          : 0;

      for (const exp of input.experiences) {
        const id = nanoid();
        let slug = exp.slug || generateSlug(exp.name);

        // Ensure unique slug by appending suffix if needed
        let suffix = 1;
        const baseSlug = slug;
        while (existingSlugs.has(slug)) {
          slug = `${baseSlug}-${suffix}`;
          suffix++;
        }
        existingSlugs.add(slug);

        await db.insert(agentExperience).values({
          id,
          agentId: input.agentId,
          slug,
          name: exp.name,
          description: exp.description ?? null,
          order: nextOrder++,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        // Assign knowledge sources
        if (exp.knowledgeSourceIds && exp.knowledgeSourceIds.length > 0) {
          await db.insert(agentExperienceKnowledge).values(
            exp.knowledgeSourceIds.map((ksId) => ({
              experienceId: id,
              knowledgeSourceId: ksId,
            })),
          );
        }

        results.push({ id, slug, name: exp.name });
      }

      await audit(
        ctx,
        "agent.updated",
        {
          type: "agent",
          id: input.agentId,
        },
        {
          action: "experience.bulk_created",
          count: results.length,
          experiences: results.map((r) => r.name),
        },
      );

      return { created: results };
    }),
});

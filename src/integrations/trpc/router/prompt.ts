import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "@/db";
import { prompt, promptVersion } from "@/db/schema";
import { audit } from "@/integrations/trpc/helpers";
import { createTRPCRouter, protectedProcedure } from "@/integrations/trpc/init";

/**
 * Prompt management router
 */
export const promptRouter = createTRPCRouter({
  /**
   * Get prompts for an agent
   */
  list: protectedProcedure
    .input(z.object({ agentId: z.string() }))
    .query(async ({ input }) => {
      return await db
        .select()
        .from(prompt)
        .where(eq(prompt.agentId, input.agentId));
    }),

  /**
   * Get prompt versions
   */
  getVersions: protectedProcedure
    .input(z.object({ promptId: z.string() }))
    .query(async ({ input }) => {
      return await db
        .select()
        .from(promptVersion)
        .where(eq(promptVersion.promptId, input.promptId))
        .orderBy(desc(promptVersion.version));
    }),

  /**
   * Get specific version by label
   */
  getByLabel: protectedProcedure
    .input(
      z.object({
        promptId: z.string(),
        label: z.enum(["dev", "staging", "prod"]),
      }),
    )
    .query(async ({ input }) => {
      const [version] = await db
        .select()
        .from(promptVersion)
        .where(
          and(
            eq(promptVersion.promptId, input.promptId),
            eq(promptVersion.label, input.label),
          ),
        )
        .limit(1);

      return version || null;
    }),

  /**
   * Create new prompt version
   */
  createVersion: protectedProcedure
    .input(
      z.object({
        promptId: z.string(),
        content: z.string(),
        variables: z.record(z.string(), z.unknown()).optional(),
        changelog: z.string().optional(),
        label: z.enum(["dev", "staging", "prod", "none"]).default("none"),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // Get existing versions to determine next version number
      const versions = await db
        .select()
        .from(promptVersion)
        .where(eq(promptVersion.promptId, input.promptId))
        .orderBy(desc(promptVersion.version));

      const nextVersion = versions.length > 0 ? versions[0].version + 1 : 1;

      const versionId = nanoid();

      // If label is not 'none', clear it from other versions
      if (input.label !== "none") {
        await db
          .update(promptVersion)
          .set({ label: "none" })
          .where(
            and(
              eq(promptVersion.promptId, input.promptId),
              eq(promptVersion.label, input.label),
            ),
          );
      }

      // Create new version
      await db.insert(promptVersion).values({
        id: versionId,
        promptId: input.promptId,
        version: nextVersion,
        label: input.label,
        content: input.content,
        variables: input.variables || {},
        changelog: input.changelog,
        createdBy: ctx.session.user.id,
        createdAt: new Date(),
      });

      // Get prompt to get agentId for audit log
      const [promptData] = await db
        .select()
        .from(prompt)
        .where(eq(prompt.id, input.promptId))
        .limit(1);

      // Audit log
      await audit(
        ctx,
        "prompt.version_created",
        { type: "prompt", id: input.promptId },
        {
          version: nextVersion,
          label: input.label,
          agentId: promptData?.agentId,
        },
      );

      return { id: versionId, version: nextVersion };
    }),

  /**
   * Assign label to a version
   */
  assignLabel: protectedProcedure
    .input(
      z.object({
        promptId: z.string(),
        version: z.number(),
        label: z.enum(["dev", "staging", "prod"]),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // Clear label from all versions of this prompt
      await db
        .update(promptVersion)
        .set({ label: "none" })
        .where(
          and(
            eq(promptVersion.promptId, input.promptId),
            eq(promptVersion.label, input.label),
          ),
        );

      // Assign label to specified version
      await db
        .update(promptVersion)
        .set({ label: input.label })
        .where(
          and(
            eq(promptVersion.promptId, input.promptId),
            eq(promptVersion.version, input.version),
          ),
        );

      // Get prompt to get agentId for audit log
      const [promptData] = await db
        .select()
        .from(prompt)
        .where(eq(prompt.id, input.promptId))
        .limit(1);

      // Audit log
      await audit(
        ctx,
        "prompt.label_assigned",
        { type: "prompt", id: input.promptId },
        {
          version: input.version,
          label: input.label,
          agentId: promptData?.agentId,
        },
      );

      return { success: true };
    }),

  /**
   * Rollback label to a previous version
   */
  rollbackLabel: protectedProcedure
    .input(
      z.object({
        promptId: z.string(),
        label: z.enum(["dev", "staging", "prod"]),
        toVersion: z.number(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // Verify version exists
      const [version] = await db
        .select()
        .from(promptVersion)
        .where(
          and(
            eq(promptVersion.promptId, input.promptId),
            eq(promptVersion.version, input.toVersion),
          ),
        )
        .limit(1);

      if (!version) {
        throw new Error("Version not found");
      }

      // Clear current label
      await db
        .update(promptVersion)
        .set({ label: "none" })
        .where(
          and(
            eq(promptVersion.promptId, input.promptId),
            eq(promptVersion.label, input.label),
          ),
        );

      // Assign label to target version
      await db
        .update(promptVersion)
        .set({ label: input.label })
        .where(
          and(
            eq(promptVersion.promptId, input.promptId),
            eq(promptVersion.version, input.toVersion),
          ),
        );

      // Get prompt to get agentId for audit log
      const [promptData] = await db
        .select()
        .from(prompt)
        .where(eq(prompt.id, input.promptId))
        .limit(1);

      // Audit log
      await audit(
        ctx,
        "prompt.label_rollback",
        { type: "prompt", id: input.promptId },
        {
          label: input.label,
          fromVersion: version.version,
          toVersion: input.toVersion,
          agentId: promptData?.agentId,
        },
      );

      return { success: true };
    }),

  /**
   * Update a prompt version
   */
  updateVersion: protectedProcedure
    .input(
      z.object({
        promptId: z.string(),
        version: z.number(),
        content: z.string().optional(),
        variables: z.record(z.string(), z.unknown()).optional(),
        changelog: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // Verify version exists
      const [existingVersion] = await db
        .select()
        .from(promptVersion)
        .where(
          and(
            eq(promptVersion.promptId, input.promptId),
            eq(promptVersion.version, input.version),
          ),
        )
        .limit(1);

      if (!existingVersion) {
        throw new Error("Version not found");
      }

      // Allow editing labeled versions, but log the change carefully
      // Note: This allows editing versions that are currently deployed to environments

      // Update the version
      const updates: Partial<typeof promptVersion.$inferInsert> = {};
      if (input.content !== undefined) updates.content = input.content;
      if (input.variables !== undefined) updates.variables = input.variables;
      if (input.changelog !== undefined) updates.changelog = input.changelog;

      await db
        .update(promptVersion)
        .set(updates)
        .where(
          and(
            eq(promptVersion.promptId, input.promptId),
            eq(promptVersion.version, input.version),
          ),
        );

      // Get prompt to get agentId for audit log
      const [promptData] = await db
        .select()
        .from(prompt)
        .where(eq(prompt.id, input.promptId))
        .limit(1);

      // Audit log
      await audit(
        ctx,
        "prompt.version_updated",
        { type: "prompt", id: input.promptId },
        {
          version: input.version,
          updates,
          agentId: promptData?.agentId,
        },
      );

      return { success: true };
    }),

  /**
   * Delete a prompt version
   */
  deleteVersion: protectedProcedure
    .input(
      z.object({
        promptId: z.string(),
        version: z.number(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // Verify version exists and is not labeled
      const [existingVersion] = await db
        .select()
        .from(promptVersion)
        .where(
          and(
            eq(promptVersion.promptId, input.promptId),
            eq(promptVersion.version, input.version),
          ),
        )
        .limit(1);

      if (!existingVersion) {
        throw new Error("Version not found");
      }

      if (existingVersion.label !== "none") {
        throw new Error("Cannot delete a version that has a label assigned");
      }

      // Check if this is the only version
      const versions = await db
        .select()
        .from(promptVersion)
        .where(eq(promptVersion.promptId, input.promptId));

      if (versions.length === 1) {
        throw new Error("Cannot delete the only version of a prompt");
      }

      // Delete the version
      await db
        .delete(promptVersion)
        .where(
          and(
            eq(promptVersion.promptId, input.promptId),
            eq(promptVersion.version, input.version),
          ),
        );

      // Get prompt to get agentId for audit log
      const [promptData] = await db
        .select()
        .from(prompt)
        .where(eq(prompt.id, input.promptId))
        .limit(1);

      // Audit log
      await audit(
        ctx,
        "prompt.version_deleted",
        { type: "prompt", id: input.promptId },
        {
          version: input.version,
          agentId: promptData?.agentId,
        },
      );

      return { success: true };
    }),
});

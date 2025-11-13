import { db } from "@/db";
import { auditLog, prompt, promptVersion } from "@/db/schema";
import { createTRPCRouter, protectedProcedure } from "@/integrations/trpc/init";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";

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
			await db.insert(auditLog).values({
				id: nanoid(),
				actorId: ctx.session.user.id,
				eventType: "prompt.version_created",
				targetType: "prompt",
				targetId: input.promptId,
				diff: {
					version: nextVersion,
					label: input.label,
					agentId: promptData?.agentId,
				},
				createdAt: new Date(),
			});

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
			await db.insert(auditLog).values({
				id: nanoid(),
				actorId: ctx.session.user.id,
				eventType: "prompt.label_assigned",
				targetType: "prompt",
				targetId: input.promptId,
				diff: {
					version: input.version,
					label: input.label,
					agentId: promptData?.agentId,
				},
				createdAt: new Date(),
			});

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
			await db.insert(auditLog).values({
				id: nanoid(),
				actorId: ctx.session.user.id,
				eventType: "prompt.label_rollback",
				targetType: "prompt",
				targetId: input.promptId,
				diff: {
					label: input.label,
					fromVersion: version.version,
					toVersion: input.toVersion,
					agentId: promptData?.agentId,
				},
				createdAt: new Date(),
			});

			return { success: true };
		}),
});

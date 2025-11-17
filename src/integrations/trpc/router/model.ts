import { db } from "@/db";
import { modelAlias } from "@/db/schema";
import { createTRPCRouter, protectedProcedure, publicProcedure } from "@/integrations/trpc/init";
import { eq } from "drizzle-orm";
import { z } from "zod";

export const modelRouter = createTRPCRouter({
  list: publicProcedure.query(async () => {
    return await db.select().from(modelAlias);
  }),
  
  create: protectedProcedure
    .input(
      z.object({
        alias: z.string().min(1).max(100),
        provider: z.enum(["openai", "openrouter", "huggingface", "workers-ai"]),
        modelId: z.string(),
        gatewayRoute: z.string().optional(),
        caps: z.any().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Ensure alias doesn't already exist
      const [existing] = await db.select().from(modelAlias).where(eq(modelAlias.alias, input.alias)).limit(1);
      if (existing) {
        throw new Error('Model alias already exists');
      }

      // Insert
      await db.insert(modelAlias).values({
        alias: input.alias,
        provider: input.provider,
        modelId: input.modelId,
        gatewayRoute: input.gatewayRoute || null,
        caps: input.caps || {},
        updatedAt: new Date(),
      });

      return { success: true };
    }),

  delete: protectedProcedure
    .input(z.object({ alias: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await db.delete(modelAlias).where(eq(modelAlias.alias, input.alias));
      return { success: true };
    }),
});
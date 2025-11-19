import { db } from "@/db";
import { modelAlias } from "@/db/schema";
import {
  adminProcedure,
  createTRPCRouter,
  publicProcedure,
} from "@/integrations/trpc/init";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { z } from "zod";

// Types for external API responses
interface CloudflareModel {
  name: string;
  description?: string;
  task?: {
    name?: string;
  };
  properties?: Array<{
    property_id?: string;
    value?: string;
  }>;
}

interface OpenAIModel {
  id: string;
  object: string;
  created?: number;
  owned_by?: string;
}

export const modelRouter = createTRPCRouter({
  list: publicProcedure.query(async () => {
    return await db.select().from(modelAlias);
  }),

  /**
   * List available models from Cloudflare Workers AI
   * Uses /accounts/{account_id}/ai/models/search endpoint
   */
  listCloudflareModels: publicProcedure
    .input(
      z.object({
        search: z.string().optional(),
        task: z.string().optional(),
        page: z.number().optional(),
        perPage: z.number().optional(),
      })
    )
    .query(async ({ input }) => {
      const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_WORKERS_API_TOKEN } = env;

      if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_WORKERS_API_TOKEN) {
        throw new Error("Cloudflare credentials not configured");
      }

      const params = new URLSearchParams();
      if (input.search) params.append("search", input.search);
      if (input.task) params.append("task", input.task);
      if (input.page) params.append("page", input.page.toString());
      if (input.perPage) params.append("per_page", input.perPage.toString());

      const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/models/search?${params.toString()}`;

      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${CLOUDFLARE_WORKERS_API_TOKEN}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch Cloudflare models: ${response.statusText}`
        );
      }

      const data = (await response.json()) as {
        success: boolean;
        result: CloudflareModel[];
        errors?: unknown[];
        messages?: string[];
      };

      if (!data.success) {
        throw new Error(`Cloudflare API error: ${JSON.stringify(data.errors)}`);
      }

      return data.result.map((model) => ({
        id: model.name,
        name: model.name,
        description: model.description || "",
        task: model.task?.name || "unknown",
      }));
    }),

  /**
   * List available models from OpenAI
   * Uses https://api.openai.com/v1/models endpoint
   */
  listOpenAIModels: publicProcedure.query(async ({ ctx }) => {
    const { OPENAI_API_KEY } = process.env;

    if (!OPENAI_API_KEY) {
      throw new Error("OpenAI API key not configured");
    }

    const response = await fetch("https://api.openai.com/v1/models", {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch OpenAI models: ${response.statusText}`);
    }

    const data = (await response.json()) as {
      data: OpenAIModel[];
      object: string;
    };

    return data.data
      .filter(
        (model) =>
          model.id.includes("gpt") ||
          model.id.includes("text-embedding") ||
          model.id.includes("whisper")
      )
      .map((model) => ({
        id: model.id,
        name: model.id,
        ownedBy: model.owned_by || "openai",
      }));
  }),

  create: adminProcedure
    .input(
      z.object({
        alias: z.string().min(1).max(100),
        provider: z.enum(["openai", "openrouter", "huggingface", "workers-ai"]),
        modelId: z.string(),
        caps: z
          .object({
            maxTokens: z.number().optional(),
            maxPricePer1k: z.number().optional(),
            streaming: z.boolean().optional(),
            contextLength: z.number().optional(),
          })
          .optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Ensure alias doesn't already exist
      const [existing] = await db
        .select()
        .from(modelAlias)
        .where(eq(modelAlias.alias, input.alias))
        .limit(1);
      if (existing) {
        throw new Error("Model alias already exists");
      }

      // Insert
      await db.insert(modelAlias).values({
        alias: input.alias,
        provider: input.provider,
        modelId: input.modelId,
        updatedAt: new Date(),
      });

      return { success: true };
    }),

  delete: adminProcedure
    .input(z.object({ alias: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await db.delete(modelAlias).where(eq(modelAlias.alias, input.alias));
      return { success: true };
    }),

  update: adminProcedure
    .input(
      z.object({
        alias: z.string().min(1).max(100),
        newAlias: z.string().min(1).max(100).optional(),
        provider: z.enum(["openai", "openrouter", "huggingface", "workers-ai"]).optional(),
        modelId: z.string().optional(),
        caps: z
          .object({
            maxTokens: z.number().optional(),
            maxPricePer1k: z.number().optional(),
            streaming: z.boolean().optional(),
            contextLength: z.number().optional(),
          })
          .optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { alias, newAlias, ...updates } = input;

      // If changing alias, check if new alias exists
      if (newAlias && newAlias !== alias) {
        const [existing] = await db
          .select()
          .from(modelAlias)
          .where(eq(modelAlias.alias, newAlias))
          .limit(1);
        if (existing) {
          throw new Error("Model alias already exists");
        }
      }

      // Update
      await db.update(modelAlias)
        .set({
          ...(newAlias && { alias: newAlias }),
          ...updates,
        })
        .where(eq(modelAlias.alias, alias));

      return { success: true };
    }),
});

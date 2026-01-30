import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agentModelPolicy, modelAlias } from "@/db/schema";
import {
  adminProcedure,
  createTRPCRouter,
  publicProcedure,
} from "@/integrations/trpc/init";
import {
  detectModelType,
  detectModelTypeFromString,
  extractCapabilities,
  getEmbeddingDimensions,
  getModel,
  getModelsByProvider,
  getProviders,
  type ModelCapabilities,
  type ModelType,
  searchModels,
} from "@/lib/ai/models-dev";

// Model type enum for classification
const modelTypeSchema = z.enum(["chat", "embedding", "reranker"]);

// Zod schema for model capabilities
const modelCapabilitiesSchema = z.object({
  inputModalities: z
    .array(z.enum(["text", "image", "audio", "video", "pdf"]))
    .optional(),
  outputModalities: z.array(z.enum(["text", "image", "audio"])).optional(),
  toolCall: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  structuredOutput: z.boolean().optional(),
  attachment: z.boolean().optional(),
  contextLength: z.number().optional(),
  maxOutputTokens: z.number().optional(),
  costInputPerMillion: z.number().optional(),
  costOutputPerMillion: z.number().optional(),
});

// Supported providers - models from these providers will be shown by default
const SUPPORTED_PROVIDERS = [
  "openai",
  "openrouter",
  "cloudflare-workers-ai",
  "huggingface",
];

export const modelRouter = createTRPCRouter({
  list: publicProcedure.query(async () => {
    return await db.select().from(modelAlias);
  }),

  /**
   * List only embedding models (for embedding model selection dropdowns)
   */
  listEmbeddingModels: publicProcedure.query(async () => {
    return await db
      .select()
      .from(modelAlias)
      .where(eq(modelAlias.modelType, "embedding"));
  }),

  /**
   * Get a single model alias by its alias name
   */
  get: publicProcedure
    .input(z.object({ alias: z.string() }))
    .query(async ({ input }) => {
      const [result] = await db
        .select()
        .from(modelAlias)
        .where(eq(modelAlias.alias, input.alias))
        .limit(1);
      return result ?? null;
    }),

  /**
   * List supported providers for filtering
   */
  listProviders: publicProcedure.query(async () => {
    const providers = await getProviders();
    // Only return providers we actually support
    return providers
      .filter((p) => SUPPORTED_PROVIDERS.includes(p.id))
      .map((p) => ({
        id: p.id,
        name: p.name,
        npm: p.npm,
        doc: p.doc,
      }));
  }),

  /**
   * Search models from supported providers
   * This is the primary way to discover and add models
   */
  searchModels: publicProcedure
    .input(
      z.object({
        query: z.string().optional(),
        provider: z.string().optional(),
        hasImageInput: z.boolean().optional(),
        hasAudioInput: z.boolean().optional(),
        hasVideoInput: z.boolean().optional(),
        hasPdfInput: z.boolean().optional(),
        hasToolCall: z.boolean().optional(),
        hasReasoning: z.boolean().optional(),
        hasStructuredOutput: z.boolean().optional(),
        excludeDeprecated: z.boolean().optional().default(true),
        minContextLength: z.number().optional(),
        maxInputCost: z.number().optional(),
        limit: z.number().optional().default(50),
      }),
    )
    .query(async ({ input }) => {
      const { limit, ...searchOptions } = input;

      let models = await searchModels(searchOptions);

      // Filter to only supported providers (unless a specific provider is requested)
      if (!input.provider) {
        models = models.filter((m) => SUPPORTED_PROVIDERS.includes(m.provider));
      }

      // Return with formatted data for UI
      return models.slice(0, limit).map((model) => ({
        id: model.id,
        provider: model.provider,
        name: model.name,
        modalities: model.modalities,
        toolCall: model.tool_call,
        reasoning: model.reasoning,
        structuredOutput: model.structured_output ?? false,
        contextLength: model.limit.context,
        maxOutputTokens: model.limit.output,
        costInput: model.cost.input,
        costOutput: model.cost.output,
        status: model.status,
        // Helper booleans for UI
        supportsImage: model.modalities.input.includes("image"),
        supportsAudio: model.modalities.input.includes("audio"),
        supportsVideo: model.modalities.input.includes("video"),
        supportsPdf: model.modalities.input.includes("pdf"),
      }));
    }),

  /**
   * Get models by provider
   */
  getModelsByProvider: publicProcedure
    .input(z.object({ provider: z.string() }))
    .query(async ({ input }) => {
      // Only allow querying supported providers
      if (!SUPPORTED_PROVIDERS.includes(input.provider)) {
        return [];
      }
      const models = await getModelsByProvider(input.provider);
      return models.map((model) => ({
        id: model.id,
        name: model.name,
        modalities: model.modalities,
        toolCall: model.tool_call,
        contextLength: model.limit.context,
        costInput: model.cost.input,
        costOutput: model.cost.output,
        supportsImage: model.modalities.input.includes("image"),
      }));
    }),

  /**
   * Get detailed model info from models.dev
   */
  getModelInfo: publicProcedure
    .input(z.object({ modelId: z.string() }))
    .query(async ({ input }) => {
      const model = await getModel(input.modelId);
      if (!model) {
        return null;
      }
      return {
        ...model,
        capabilities: extractCapabilities(model),
      };
    }),

  /**
   * Create a new model alias with capabilities from models.dev
   * Model type and embedding dimensions are auto-detected from models.dev
   * or inferred from naming conventions
   */
  create: adminProcedure
    .input(
      z.object({
        alias: z.string().min(1).max(100),
        provider: z.enum([
          "openai",
          "openrouter",
          "huggingface",
          "cloudflare-workers-ai",
        ]),
        modelId: z.string(),
        // Optional: auto-fetch capabilities from models.dev
        modelsDevId: z.string().optional(),
        // Override model type (auto-detected by default)
        modelType: modelTypeSchema.optional(),
        // Override embedding dimensions (auto-detected for embedding models)
        embeddingDimensions: z.number().optional(),
        // Or provide capabilities manually
        capabilities: modelCapabilitiesSchema.optional(),
      }),
    )
    .mutation(async ({ input }) => {
      // Ensure alias doesn't already exist
      const [existing] = await db
        .select()
        .from(modelAlias)
        .where(eq(modelAlias.alias, input.alias))
        .limit(1);
      if (existing) {
        throw new Error("Model alias already exists");
      }

      // Try to fetch from models.dev for auto-detection
      let capabilities: ModelCapabilities | undefined;
      let detectedType: ModelType = "chat";
      let detectedDimensions: number | undefined;

      if (input.modelsDevId) {
        const modelInfo = await getModel(input.modelsDevId);
        if (modelInfo) {
          capabilities = extractCapabilities(modelInfo);
          detectedType = detectModelType(modelInfo);
          detectedDimensions = getEmbeddingDimensions(modelInfo);
        }
      } else if (input.capabilities) {
        capabilities = input.capabilities as ModelCapabilities;
      }

      // Use provided values or fall back to detected/inferred values
      const finalModelType =
        input.modelType ??
        detectedType ??
        detectModelTypeFromString(input.modelId);
      const finalDimensions = input.embeddingDimensions ?? detectedDimensions;

      // Validate embedding models have dimensions
      if (finalModelType === "embedding" && !finalDimensions) {
        throw new Error(
          "Embedding models must have dimensions. Provide embeddingDimensions or use a modelsDevId that includes dimension info.",
        );
      }

      // Insert with capabilities
      await db.insert(modelAlias).values({
        alias: input.alias,
        provider: input.provider,
        modelId: input.modelId,
        modelType: finalModelType,
        embeddingDimensions: finalDimensions ?? null,
        capabilities: capabilities ?? null,
        updatedAt: new Date(),
      });

      return {
        success: true,
        modelType: finalModelType,
        embeddingDimensions: finalDimensions,
      };
    }),

  delete: adminProcedure
    .input(z.object({ alias: z.string() }))
    .mutation(async ({ input }) => {
      await db.delete(modelAlias).where(eq(modelAlias.alias, input.alias));
      return { success: true };
    }),

  update: adminProcedure
    .input(
      z.object({
        alias: z.string().min(1).max(100),
        newAlias: z.string().min(1).max(100).optional(),
        provider: z
          .enum([
            "openai",
            "openrouter",
            "huggingface",
            "cloudflare-workers-ai",
          ])
          .optional(),
        modelId: z.string().optional(),
        // Model type classification (auto-detected if modelsDevId provided)
        modelType: modelTypeSchema.optional(),
        // Embedding dimensions (auto-detected for embedding models)
        embeddingDimensions: z.number().optional().nullable(),
        // Optional: refresh capabilities from models.dev (also refreshes type/dimensions)
        modelsDevId: z.string().optional(),
        // Or update capabilities manually
        capabilities: modelCapabilitiesSchema.optional(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        const {
          alias,
          newAlias,
          modelsDevId,
          capabilities,
          modelType,
          embeddingDimensions,
          ...updates
        } = input;

        // Fetch capabilities and auto-detect type if modelsDevId provided
        let capabilitiesToUpdate: ModelCapabilities | undefined;
        let detectedType: ModelType | undefined;
        let detectedDimensions: number | undefined;

        if (modelsDevId) {
          const modelInfo = await getModel(modelsDevId);
          if (modelInfo) {
            capabilitiesToUpdate = extractCapabilities(modelInfo);
            detectedType = detectModelType(modelInfo);
            detectedDimensions = getEmbeddingDimensions(modelInfo);
          }
        } else if (capabilities) {
          capabilitiesToUpdate = capabilities as ModelCapabilities;
        }

        // Use provided values or fall back to detected values
        const finalModelType = modelType ?? detectedType;
        const finalDimensions =
          embeddingDimensions !== undefined
            ? embeddingDimensions
            : detectedDimensions;

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

        // If changing alias, we need to handle foreign key references
        if (newAlias && newAlias !== alias) {
          // Get current model alias data
          const [current] = await db
            .select()
            .from(modelAlias)
            .where(eq(modelAlias.alias, alias))
            .limit(1);
          if (!current) {
            throw new Error("Model alias not found");
          }

          // Insert new alias with updated data
          await db.insert(modelAlias).values({
            alias: newAlias,
            provider: updates.provider ?? current.provider,
            modelId: updates.modelId ?? current.modelId,
            modelType: finalModelType ?? current.modelType,
            embeddingDimensions: finalDimensions ?? current.embeddingDimensions,
            capabilities: capabilitiesToUpdate ?? current.capabilities,
            updatedAt: new Date(),
          });

          // Update foreign key references
          await db
            .update(agentModelPolicy)
            .set({ modelAlias: newAlias })
            .where(eq(agentModelPolicy.modelAlias, alias));

          // Delete old alias
          await db.delete(modelAlias).where(eq(modelAlias.alias, alias));
        } else {
          // Simple update without alias change
          const updateData: Record<string, unknown> = {
            ...updates,
            updatedAt: new Date(),
          };

          if (finalModelType !== undefined) {
            updateData.modelType = finalModelType;
          }

          if (finalDimensions !== undefined) {
            updateData.embeddingDimensions = finalDimensions;
          }

          if (capabilitiesToUpdate) {
            updateData.capabilities = capabilitiesToUpdate;
          }

          if (Object.keys(updateData).length > 1) {
            // More than just updatedAt
            await db
              .update(modelAlias)
              .set(updateData)
              .where(eq(modelAlias.alias, alias));
          } else {
            console.warn(
              "[Model Update] No changes to apply for alias:",
              alias,
            );
          }
        }

        return { success: true };
      } catch (error) {
        throw new Error(
          `Failed to update model alias: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }),

  /**
   * Check if a model supports a specific capability
   * Useful for UI to enable/disable features based on model capabilities
   */
  checkCapabilities: publicProcedure
    .input(
      z.object({
        alias: z.string(),
      }),
    )
    .query(async ({ input }) => {
      const [aliasRecord] = await db
        .select()
        .from(modelAlias)
        .where(eq(modelAlias.alias, input.alias))
        .limit(1);

      if (!aliasRecord) {
        return null;
      }

      const caps = aliasRecord.capabilities as ModelCapabilities | null;

      return {
        alias: aliasRecord.alias,
        provider: aliasRecord.provider,
        modelId: aliasRecord.modelId,
        supportsImage: caps?.inputModalities?.includes("image") ?? false,
        supportsAudio: caps?.inputModalities?.includes("audio") ?? false,
        supportsVideo: caps?.inputModalities?.includes("video") ?? false,
        supportsPdf: caps?.inputModalities?.includes("pdf") ?? false,
        supportsToolCall: caps?.toolCall ?? false,
        supportsReasoning: caps?.reasoning ?? false,
        supportsStructuredOutput: caps?.structuredOutput ?? false,
        contextLength: caps?.contextLength,
        maxOutputTokens: caps?.maxOutputTokens,
        costInputPerMillion: caps?.costInputPerMillion,
        costOutputPerMillion: caps?.costOutputPerMillion,
        hasCapabilities: !!caps,
      };
    }),
});

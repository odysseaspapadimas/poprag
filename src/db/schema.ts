import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const user = sqliteTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: integer("email_verified", { mode: "boolean" })
      .default(false)
      .notNull(),
    image: text("image"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    isAdmin: integer("is_admin", { mode: "boolean" }).default(false),
  },
  (table) => [index("user_email_idx").on(table.email)],
);

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("session_user_id_idx").on(table.userId),
    index("session_token_idx").on(table.token),
  ],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", {
      mode: "timestamp_ms",
    }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", {
      mode: "timestamp_ms",
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("account_user_id_idx").on(table.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

// ─────────────────────────────────────────────────────
// Type exports
// ─────────────────────────────────────────────────────
export type User = typeof user.$inferSelect;
export type InsertUser = typeof user.$inferInsert;

export type AuthSession = typeof session.$inferSelect;
export type InsertAuthSession = typeof session.$inferInsert;

export type Account = typeof account.$inferSelect;
export type InsertAccount = typeof account.$inferInsert;

export type Verification = typeof verification.$inferSelect;
export type InsertVerification = typeof verification.$inferInsert;

// ─────────────────────────────────────────────────────
// Agent & RAG Tables
// ─────────────────────────────────────────────────────

export const agent = sqliteTable(
  "agent",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    description: text("description"),
    status: text("status", { enum: ["draft", "active", "archived"] })
      .default("draft")
      .notNull(),
    visibility: text("visibility", {
      enum: ["private", "public"],
    })
      .default("private")
      .notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
    lastDeployedAt: integer("last_deployed_at", { mode: "timestamp_ms" }),
    ragEnabled: integer("rag_enabled", { mode: "boolean" })
      .default(true)
      .notNull(),
    rewriteQuery: integer("rewrite_query", { mode: "boolean" })
      .default(true)
      .notNull(),
    rewriteModel: text("rewrite_model"),
    skipIntentClassification: integer("skip_intent_classification", {
      mode: "boolean",
    })
      .default(false)
      .notNull(),
    intentModel: text("intent_model"),
    queryVariationsCount: integer("query_variations_count").default(3),
    rerank: integer("rerank", { mode: "boolean" }).default(true).notNull(),
    rerankModel: text("rerank_model"),
    topK: integer("top_k").default(5),
    minSimilarity: integer("min_similarity").default(15),
  },
  (table) => [
    index("agent_slug_idx").on(table.slug),
    index("agent_status_idx").on(table.status),
    index("agent_created_by_idx").on(table.createdBy),
  ],
);

export const modelAlias = sqliteTable(
  "model_alias",
  {
    alias: text("alias").primaryKey(),
    provider: text("provider", {
      enum: ["openai", "openrouter", "huggingface", "cloudflare-workers-ai"],
    }).notNull(),
    modelId: text("model_id").notNull(),
    // Model type classification
    modelType: text("model_type", {
      enum: ["chat", "embedding", "reranker"],
    })
      .default("chat")
      .notNull(),
    // Embedding dimensions (only relevant for embedding models)
    embeddingDimensions: integer("embedding_dimensions"),
    // Model capabilities from models.dev
    capabilities: text("capabilities", { mode: "json" }).$type<{
      inputModalities?: ("text" | "image" | "audio" | "video" | "pdf")[];
      outputModalities?: ("text" | "image" | "audio")[];
      toolCall?: boolean;
      reasoning?: boolean;
      structuredOutput?: boolean;
      attachment?: boolean;
      contextLength?: number;
      maxOutputTokens?: number;
      costInputPerMillion?: number;
      costOutputPerMillion?: number;
    }>(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("model_alias_provider_idx").on(table.provider)],
);

export const agentModelPolicy = sqliteTable(
  "agent_model_policy",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    modelAlias: text("model_alias")
      .notNull()
      .references(() => modelAlias.alias),
    temperature: integer("temperature"),
    topP: integer("top_p"),
    maxTokens: integer("max_tokens"),
    presencePenalty: integer("presence_penalty"),
    frequencyPenalty: integer("frequency_penalty"),
    responseFormat: text("response_format", { mode: "json" }).$type<{
      type?: string;
      schema?: unknown;
    }>(),
    effectiveFrom: integer("effective_from", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    effectiveTo: integer("effective_to", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("agent_model_policy_agent_idx").on(
      table.agentId,
      table.effectiveFrom,
    ),
  ],
);

export const prompt = sqliteTable(
  "prompt",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    key: text("key", { enum: ["system", "user", "tool", "other"] })
      .default("system")
      .notNull(),
    description: text("description"),
  },
  (table) => [
    index("prompt_agent_idx").on(table.agentId),
    index("prompt_agent_key_idx").on(table.agentId, table.key),
  ],
);

export const promptVersion = sqliteTable(
  "prompt_version",
  {
    id: text("id").primaryKey(),
    promptId: text("prompt_id")
      .notNull()
      .references(() => prompt.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    label: text("label", { enum: ["dev", "staging", "prod", "none"] })
      .default("none")
      .notNull(),
    content: text("content").notNull(),
    variables: text("variables", { mode: "json" }).$type<
      Record<string, unknown>
    >(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    changelog: text("changelog"),
  },
  (table) => [
    index("prompt_version_prompt_idx").on(table.promptId, table.version),
    index("prompt_version_label_idx").on(table.promptId, table.label),
  ],
);

export const knowledgeSource = sqliteTable(
  "knowledge_source",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    type: text("type", { enum: ["r2-file", "url", "manual", "dataset"] })
      .default("r2-file")
      .notNull(),
    r2Bucket: text("r2_bucket"),
    r2Key: text("r2_key"),
    fileName: text("file_name"),
    mime: text("mime"),
    bytes: integer("bytes"),
    checksum: text("checksum"),
    status: text("status", {
      enum: ["uploaded", "parsed", "processing", "indexed", "failed"],
    })
      .default("uploaded")
      .notNull(),
    progress: integer("progress").default(0),
    progressMessage: text("progress_message"),
    retryCount: integer("retry_count").default(0).notNull(),
    parserErrors: text("parser_errors", { mode: "json" }).$type<string[]>(),
    vectorizeIds: text("vectorize_ids", { mode: "json" }).$type<
      string[] | null
    >(), // Track vectors for this source
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("knowledge_source_agent_idx").on(table.agentId),
    index("knowledge_source_status_idx").on(table.agentId, table.status),
  ],
);

export const catalogProduct = sqliteTable(
  "catalog_product",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => knowledgeSource.id, { onDelete: "cascade" }),
    indexVersion: integer("index_version").default(0).notNull(),
    recordKey: text("record_key").notNull(),
    recordHash: text("record_hash").notNull(),
    title: text("title"),
    searchText: text("search_text"),
    data: text("data", { mode: "json" }).$type<Record<string, unknown>>(),
    status: text("status", { enum: ["active", "inactive"] })
      .default("active")
      .notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    deactivatedAt: integer("deactivated_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("catalog_product_source_record_key_version_idx").on(
      table.sourceId,
      table.recordKey,
      table.indexVersion,
    ),
    index("catalog_product_agent_idx").on(table.agentId),
    index("catalog_product_source_status_idx").on(table.sourceId, table.status),
    index("catalog_product_source_version_idx").on(
      table.sourceId,
      table.indexVersion,
      table.status,
    ),
    index("catalog_product_record_key_idx").on(table.recordKey),
  ],
);

export const catalogProductFact = sqliteTable(
  "catalog_product_fact",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => knowledgeSource.id, { onDelete: "cascade" }),
    indexVersion: integer("index_version").default(0).notNull(),
    productId: text("product_id")
      .notNull()
      .references(() => catalogProduct.id, { onDelete: "cascade" }),
    fieldPath: text("field_path").notNull(),
    role: text("role", {
      enum: ["stable_key", "title", "exact", "searchable", "filterable"],
    }).notNull(),
    value: text("value").notNull(),
    normalizedValue: text("normalized_value").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    index("catalog_product_fact_agent_idx").on(table.agentId),
    index("catalog_product_fact_source_idx").on(table.sourceId),
    index("catalog_product_fact_product_idx").on(table.productId),
    index("catalog_product_fact_source_version_idx").on(
      table.sourceId,
      table.indexVersion,
    ),
    index("catalog_product_fact_field_idx").on(table.fieldPath),
    index("catalog_product_fact_lookup_idx").on(
      table.agentId,
      table.role,
      table.normalizedValue,
    ),
    index("catalog_product_fact_filter_idx").on(
      table.agentId,
      table.fieldPath,
      table.normalizedValue,
    ),
  ],
);

export const documentChunks = sqliteTable(
  "document_chunks",
  {
    id: text("id").primaryKey(),
    documentId: text("source_id") // Maps to source_id column in database
      .notNull()
      .references(() => knowledgeSource.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    sessionId: text("agent_id").notNull(), // Maps to agent_id column in database
    chunkIndex: integer("chunk_index").notNull(),
    vectorizeId: text("vectorize_id"), // Link to Vectorize vector
    productId: text("product_id").references(() => catalogProduct.id, {
      onDelete: "set null",
    }),
    catalogIndexVersion: integer("catalog_index_version"),
    recordKey: text("record_key"),
    recordHash: text("record_hash"),
    metadata: text("metadata", { mode: "json" }).$type<
      Record<string, unknown>
    >(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    index("document_chunks_document_idx").on(table.documentId),
    index("document_chunks_session_idx").on(table.sessionId),
    index("document_chunks_product_idx").on(table.productId),
    index("document_chunks_catalog_version_idx").on(
      table.documentId,
      table.catalogIndexVersion,
    ),
    index("document_chunks_record_key_idx").on(
      table.documentId,
      table.recordKey,
    ),
  ],
);

export const agentIndexPin = sqliteTable(
  "agent_index_pin",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" })
      .unique(),
    indexVersion: integer("index_version").notNull(),
    pinnedAt: integer("pinned_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    pinnedBy: text("pinned_by")
      .notNull()
      .references(() => user.id),
  },
  (table) => [index("agent_index_pin_agent_idx").on(table.agentId)],
);

export const evalDataset = sqliteTable("eval_dataset", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  items: text("items").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
});

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id")
      .notNull()
      .references(() => user.id),
    eventType: text("event_type").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    diff: text("diff", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    index("audit_log_target_idx").on(
      table.targetType,
      table.targetId,
      table.createdAt,
    ),
    index("audit_log_actor_idx").on(table.actorId),
  ],
);

export const transcript = sqliteTable(
  "transcript",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id").notNull(),
    runId: text("run_id").notNull(),
    initiatedBy: text("initiated_by").references(() => user.id),
    firebaseUid: text("firebase_uid"), // Firebase user who made the request (external API)
    request: text("request", { mode: "json" }).$type<Record<string, unknown>>(),
    response: text("response", { mode: "json" }).$type<
      Record<string, unknown>
    >(),
    usage: text("usage", { mode: "json" }).$type<{
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    }>(),
    latencyMs: integer("latency_ms"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    index("transcript_agent_idx").on(table.agentId),
    index("transcript_conversation_idx").on(table.conversationId),
    index("transcript_firebase_uid_idx").on(table.firebaseUid),
  ],
);

export const runMetric = sqliteTable(
  "run_metric",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    conversationId: text("conversation_id"),
    initiatedBy: text("initiated_by").references(() => user.id),
    firebaseUid: text("firebase_uid"), // Firebase user who made the request (external API)
    modelAlias: text("model_alias"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    totalTokens: integer("total_tokens"),
    tokens: integer("tokens"),
    costMicrocents: integer("cost_microcents"),
    latencyMs: integer("latency_ms"),
    timeToFirstTokenMs: integer("time_to_first_token_ms"),
    errorType: text("error_type"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    index("run_metric_agent_idx").on(table.agentId, table.createdAt),
    index("run_metric_run_idx").on(table.runId),
    index("run_metric_conversation_idx").on(table.conversationId),
    index("run_metric_initiated_by_idx").on(table.initiatedBy),
    index("run_metric_firebase_uid_idx").on(table.firebaseUid),
  ],
);

export const chatImage = sqliteTable(
  "chat_image",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id").notNull(),
    r2Bucket: text("r2_bucket"),
    r2Key: text("r2_key"),
    fileName: text("file_name"),
    mime: text("mime"),
    bytes: integer("bytes"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("chat_image_agent_idx").on(table.agentId),
    index("chat_image_conversation_idx").on(table.conversationId),
  ],
);

// ─────────────────────────────────────────────────────
// Agent Experiences (Knowledge Groups)
// ─────────────────────────────────────────────────────

export const agentExperience = sqliteTable(
  "agent_experience",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(), // e.g., "math-101", "biology-grade10"
    name: text("name").notNull(),
    description: text("description"),
    order: integer("order").default(0),
    isActive: integer("is_active", { mode: "boolean" }).default(true).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("agent_experience_agent_idx").on(table.agentId),
    index("agent_experience_slug_idx").on(table.agentId, table.slug),
  ],
);

export const agentExperienceKnowledge = sqliteTable(
  "agent_experience_knowledge",
  {
    experienceId: text("experience_id")
      .notNull()
      .references(() => agentExperience.id, { onDelete: "cascade" }),
    knowledgeSourceId: text("knowledge_source_id")
      .notNull()
      .references(() => knowledgeSource.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.experienceId, table.knowledgeSourceId] }),
    index("agent_exp_knowledge_exp_idx").on(table.experienceId),
    index("agent_exp_knowledge_source_idx").on(table.knowledgeSourceId),
  ],
);

export const catalogConfig = sqliteTable(
  "catalog_config",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    knowledgeSourceId: text("knowledge_source_id")
      .notNull()
      .references(() => knowledgeSource.id, { onDelete: "cascade" })
      .unique(),
    experienceId: text("experience_id").references(() => agentExperience.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    scopeName: text("scope_name"),
    scopeAliases: text("scope_aliases", { mode: "json" })
      .$type<string[]>()
      .default(sql`('[]')`),
    origin: text("origin", { enum: ["api", "csv"] }).notNull(),
    enabled: integer("enabled", { mode: "boolean" }).default(true).notNull(),
    activeIndexVersion: integer("active_index_version").default(0).notNull(),
    stableKeyField: text("stable_key_field").notNull(),
    updatedAtField: text("updated_at_field"),
    deletionField: text("deletion_field"),
    deletionInactiveValues: text("deletion_inactive_values", {
      mode: "json",
    }).$type<string[]>(),
    titleField: text("title_field").notNull(),
    searchableFields: text("searchable_fields", { mode: "json" })
      .$type<string[]>()
      .default(sql`('[]')`),
    exactMatchFields: text("exact_match_fields", { mode: "json" })
      .$type<string[]>()
      .default(sql`('[]')`),
    filterableFields: text("filterable_fields", { mode: "json" })
      .$type<string[]>()
      .default(sql`('[]')`),
    includeFilters: text("include_filters", { mode: "json" })
      .$type<Array<{ fieldPath: string; values: string[] }>>()
      .default(sql`('[]')`),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("catalog_config_agent_idx").on(table.agentId),
    index("catalog_config_source_idx").on(table.knowledgeSourceId),
    index("catalog_config_enabled_idx").on(table.agentId, table.enabled),
    index("catalog_config_origin_idx").on(table.origin),
  ],
);

export const catalogIndexVersion = sqliteTable(
  "catalog_index_version",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => knowledgeSource.id, { onDelete: "cascade" }),
    catalogConfigId: text("catalog_config_id")
      .notNull()
      .references(() => catalogConfig.id, { onDelete: "cascade" }),
    runId: text("run_id"),
    version: integer("version").notNull(),
    status: text("status", {
      enum: ["building", "active", "superseded", "failed"],
    })
      .default("building")
      .notNull(),
    stats: text("stats", { mode: "json" }).$type<Record<string, unknown>>(),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    promotedAt: integer("promoted_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("catalog_index_version_source_version_idx").on(
      table.sourceId,
      table.version,
    ),
    index("catalog_index_version_source_status_idx").on(
      table.sourceId,
      table.status,
    ),
    index("catalog_index_version_config_idx").on(table.catalogConfigId),
  ],
);

export const catalogSyncConfig = sqliteTable(
  "catalog_sync_config",
  {
    id: text("id").primaryKey(),
    catalogConfigId: text("catalog_config_id").references(
      () => catalogConfig.id,
      { onDelete: "set null" },
    ),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    knowledgeSourceId: text("knowledge_source_id")
      .notNull()
      .references(() => knowledgeSource.id, { onDelete: "cascade" })
      .unique(),
    experienceId: text("experience_id").references(() => agentExperience.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).default(true).notNull(),
    snapshotUrl: text("snapshot_url").notNull(),
    diffUrl: text("diff_url").notNull(),
    authHeaderName: text("auth_header_name"),
    authSecretName: text("auth_secret_name"),
    updatedSinceParam: text("updated_since_param")
      .default("effectiveUpdatedAfter")
      .notNull(),
    itemPath: text("item_path").default("").notNull(),
    stableKeyField: text("stable_key_field").notNull(),
    updatedAtField: text("updated_at_field"),
    deletionField: text("deletion_field"),
    deletionInactiveValues: text("deletion_inactive_values", {
      mode: "json",
    }).$type<string[]>(),
    titleField: text("title_field").notNull(),
    searchableFields: text("searchable_fields", { mode: "json" })
      .$type<string[]>()
      .default(sql`('[]')`),
    exactMatchFields: text("exact_match_fields", { mode: "json" })
      .$type<string[]>()
      .default(sql`('[]')`),
    includeFilters: text("include_filters", { mode: "json" })
      .$type<Array<{ fieldPath: string; values: string[] }>>()
      .default(sql`('[]')`),
    syncIntervalDays: integer("sync_interval_days").default(7).notNull(),
    scheduleWeekdayUtc: integer("schedule_weekday_utc").default(1).notNull(),
    scheduleHourUtc: integer("schedule_hour_utc").default(3).notNull(),
    nextRunAt: integer("next_run_at", { mode: "timestamp_ms" }),
    cursorLastSuccessfulAt: integer("cursor_last_successful_at", {
      mode: "timestamp_ms",
    }),
    lastCheckedAt: integer("last_checked_at", { mode: "timestamp_ms" }),
    lastSuccessfulSyncAt: integer("last_successful_sync_at", {
      mode: "timestamp_ms",
    }),
    lastRunId: text("last_run_id"),
    lastRunStatus: text("last_run_status", {
      enum: ["queued", "running", "succeeded", "failed", "skipped"],
    }),
    lastRunError: text("last_run_error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("catalog_sync_config_catalog_idx").on(table.catalogConfigId),
    index("catalog_sync_config_agent_idx").on(table.agentId),
    index("catalog_sync_config_due_idx").on(table.enabled, table.nextRunAt),
    index("catalog_sync_config_source_idx").on(table.knowledgeSourceId),
  ],
);

export const catalogSyncRun = sqliteTable(
  "catalog_sync_run",
  {
    id: text("id").primaryKey(),
    configId: text("config_id")
      .notNull()
      .references(() => catalogSyncConfig.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    knowledgeSourceId: text("knowledge_source_id")
      .notNull()
      .references(() => knowledgeSource.id, { onDelete: "cascade" }),
    workflowInstanceId: text("workflow_instance_id"),
    trigger: text("trigger", { enum: ["manual", "scheduled"] })
      .default("manual")
      .notNull(),
    mode: text("mode", { enum: ["auto", "diff", "snapshot"] })
      .default("auto")
      .notNull(),
    status: text("status", {
      enum: ["queued", "running", "succeeded", "failed", "skipped"],
    })
      .default("queued")
      .notNull(),
    checkedSince: integer("checked_since", { mode: "timestamp_ms" }),
    nextCursorAt: integer("next_cursor_at", { mode: "timestamp_ms" }),
    rawR2Key: text("raw_r2_key"),
    stats: text("stats", { mode: "json" }).$type<Record<string, unknown>>(),
    error: text("error"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("catalog_sync_run_config_idx").on(table.configId, table.createdAt),
    index("catalog_sync_run_source_idx").on(table.knowledgeSourceId),
    index("catalog_sync_run_status_idx").on(table.status),
  ],
);

// ─────────────────────────────────────────────────────
// Agent Type exports
// ─────────────────────────────────────────────────────
export type Agent = typeof agent.$inferSelect;
export type InsertAgent = typeof agent.$inferInsert;

export type ModelAlias = typeof modelAlias.$inferSelect;
export type InsertModelAlias = typeof modelAlias.$inferInsert;

export type AgentModelPolicy = typeof agentModelPolicy.$inferSelect;
export type InsertAgentModelPolicy = typeof agentModelPolicy.$inferInsert;

export type Prompt = typeof prompt.$inferSelect;
export type InsertPrompt = typeof prompt.$inferInsert;

export type PromptVersion = typeof promptVersion.$inferSelect;
export type InsertPromptVersion = typeof promptVersion.$inferInsert;

export type KnowledgeSource = typeof knowledgeSource.$inferSelect;
export type InsertKnowledgeSource = typeof knowledgeSource.$inferInsert;

export type CatalogProduct = typeof catalogProduct.$inferSelect;
export type InsertCatalogProduct = typeof catalogProduct.$inferInsert;
export type CatalogConfig = typeof catalogConfig.$inferSelect;
export type InsertCatalogConfig = typeof catalogConfig.$inferInsert;
export type CatalogIndexVersion = typeof catalogIndexVersion.$inferSelect;
export type InsertCatalogIndexVersion = typeof catalogIndexVersion.$inferInsert;
export type CatalogProductFact = typeof catalogProductFact.$inferSelect;
export type InsertCatalogProductFact = typeof catalogProductFact.$inferInsert;

export type DocumentChunk = typeof documentChunks.$inferSelect;
export type InsertDocumentChunk = typeof documentChunks.$inferInsert;

export type AgentIndexPin = typeof agentIndexPin.$inferSelect;
export type InsertAgentIndexPin = typeof agentIndexPin.$inferInsert;

export type EvalDataset = typeof evalDataset.$inferSelect;
export type InsertEvalDataset = typeof evalDataset.$inferInsert;

export type AuditLog = typeof auditLog.$inferSelect;
export type InsertAuditLog = typeof auditLog.$inferInsert;

export type Transcript = typeof transcript.$inferSelect;
export type InsertTranscript = typeof transcript.$inferInsert;

export type RunMetric = typeof runMetric.$inferSelect;
export type InsertRunMetric = typeof runMetric.$inferInsert;

export type ChatImage = typeof chatImage.$inferSelect;
export type InsertChatImage = typeof chatImage.$inferInsert;

export type AgentExperience = typeof agentExperience.$inferSelect;
export type InsertAgentExperience = typeof agentExperience.$inferInsert;

export type AgentExperienceKnowledge =
  typeof agentExperienceKnowledge.$inferSelect;
export type InsertAgentExperienceKnowledge =
  typeof agentExperienceKnowledge.$inferInsert;

export type CatalogSyncConfig = typeof catalogSyncConfig.$inferSelect;
export type InsertCatalogSyncConfig = typeof catalogSyncConfig.$inferInsert;
export type CatalogSyncRun = typeof catalogSyncRun.$inferSelect;
export type InsertCatalogSyncRun = typeof catalogSyncRun.$inferInsert;

// ─────────────────────────────────────────────────────
// Firebase User (for external API authentication)
// ─────────────────────────────────────────────────────

export const firebaseUser = sqliteTable(
  "firebase_user",
  {
    uid: text("uid").primaryKey(), // Firebase UID
    email: text("email"),
    displayName: text("display_name"),
    photoUrl: text("photo_url"),
    signInProvider: text("sign_in_provider"), // google.com, password, etc.
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    totalRequests: integer("total_requests").default(0).notNull(),
    // Optional: link to dashboard user for extended permissions
    linkedUserId: text("linked_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    index("firebase_user_email_idx").on(table.email),
    index("firebase_user_linked_user_idx").on(table.linkedUserId),
  ],
);

export type FirebaseUser = typeof firebaseUser.$inferSelect;
export type InsertFirebaseUser = typeof firebaseUser.$inferInsert;

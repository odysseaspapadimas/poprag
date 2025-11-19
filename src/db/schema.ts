import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
      enum: ["private", "workspace", "public"],
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
      enum: ["openai", "openrouter", "huggingface", "workers-ai"],
    }).notNull(),
    modelId: text("model_id").notNull(),
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
    presencePenalty: integer("presence_penalty"),
    frequencyPenalty: integer("frequency_penalty"),
    maxTokens: integer("max_tokens"),
    responseFormat: text("response_format", { mode: "json" }).$type<{
      type?: string;
      schema?: unknown;
    }>(),
    enabledTools: text("enabled_tools", { mode: "json" }).$type<string[]>(),
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
      enum: ["uploaded", "parsed", "indexed", "failed"],
    })
      .default("uploaded")
      .notNull(),
    parserErrors: text("parser_errors", { mode: "json" }).$type<string[]>(),
    vectorizeIds: text("vectorize_ids", { mode: "json" }).$type<string[] | null>(), // Track vectors for this source
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

export const documentChunks = sqliteTable(
  "document_chunks",
  {
    id: text("id").primaryKey(),
    documentId: text("source_id")  // Maps to source_id column in database
      .notNull()
      .references(() => knowledgeSource.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    sessionId: text("agent_id").notNull(),  // Maps to agent_id column in database
    chunkIndex: integer("chunk_index").notNull(),
    vectorizeId: text("vectorize_id"), // Link to Vectorize vector
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    index("document_chunks_document_idx").on(table.documentId),
    index("document_chunks_session_idx").on(table.sessionId),
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
    tokens: integer("tokens"),
    costMicrocents: integer("cost_microcents"),
    latencyMs: integer("latency_ms"),
    errorType: text("error_type"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    index("run_metric_agent_idx").on(table.agentId, table.createdAt),
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

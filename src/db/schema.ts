import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const user = sqliteTable(
  "user",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    emailVerified: integer("email_verified", { mode: 'boolean' }).notNull(),
    image: text("image"),
    isAnonymous: integer("is_anonymous", { mode: 'boolean' }).notNull(),
    name: text("name").notNull(),
    createdAt: integer("created_at", { mode: 'timestamp' }).notNull().defaultNow(),
    updatedAt: integer("updated_at", { mode: 'timestamp' }).notNull(),
  },
  (table) => [index("user_email_idx").on(table.email)],
);

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: 'timestamp' }).notNull(),
    ipAddress: text("ip_address"),
    token: text("token").notNull().unique(),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: 'timestamp' }).notNull(),
    updatedAt: integer("updated_at", { mode: 'timestamp' }).notNull(),
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
    accessToken: text("access_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: 'timestamp' }),
    accountId: text("account_id").notNull(),
    idToken: text("id_token"),
    password: text("password"),
    providerId: text("provider_id").notNull(),
    refreshToken: text("refresh_token"),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: 'timestamp' }),
    scope: text("scope"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: 'timestamp' }).notNull(),
    updatedAt: integer("updated_at", { mode: 'timestamp' }).notNull(),
  },
  (table) => [index("account_user_id_idx").on(table.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: 'timestamp' }).notNull(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    createdAt: integer("created_at", { mode: 'timestamp' }),
    updatedAt: integer("updated_at", { mode: 'timestamp' }),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

import "dotenv/config";

import { type Config, defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  dialect: "sqlite",
  driver: "d1-http",
  out: "./drizzle/migrations",
  dbCredentials: {
    accountId: process.env.D1_ACCOUNT_ID || "D1_ACCOUNT_ID",
    databaseId: process.env.D1_DATABASE_ID || "D1_DATABASE_ID",
    token: process.env.D1_TOKEN || "D1_TOKEN",
  },
}) satisfies Config;

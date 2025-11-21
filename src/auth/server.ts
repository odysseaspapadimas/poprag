import { db } from "@/db";
import * as schema from "@/db/schema";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { reactStartCookies } from "better-auth/react-start";

export const auth = betterAuth({
  database: drizzleAdapter(db as any, {
    provider: "sqlite",
    schema,
  }),
  user: {
    additionalFields: {
      isAdmin: {
        type: "boolean",
        required: false,
        defaultValue: false,
        input: false,
      },
    },
  },
  // Google OAuth
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
  },

  // Session configuration
  session: {
    // Keep the session alive for 30 days (30 * 24 * 60 * 60 seconds)
    expiresIn: 30 * 24 * 60 * 60, // 30 days
    // How often the session should be refreshed (server-side rolling)
    updateAge: 24 * 60 * 60, // 1 day
    cookieCache: {
      enabled: true,
      // Keep the client-side cookie cache in sync with session lifetime to
      // avoid the client cache expiring before the server session does.
      // Set to 30 days (seconds).
      maxAge: 30 * 24 * 60 * 60, // 30 days
    },
  },

  // TanStack Start cookie integration - handles all cookie setting automatically!
  plugins: [
    reactStartCookies(), // Must be last plugin
  ],
});

import type { TRPCRouterRecord } from "@trpc/server";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { isStagingAuthEnabled, shouldAutoAdminSignUps } from "@/auth/env";
import { auth } from "@/auth/server";
import { ensureStagingAdminSession } from "@/auth/staging-admin";
import { user } from "@/db/schema";
import { protectedProcedure, publicProcedure } from "../init";

const LoginSchema = z.object({
  email: z.email(),
  password: z.string().min(6),
});

const SignUpSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().min(1),
});

export const authRouter = {
  login: publicProcedure.input(LoginSchema).mutation(async ({ input, ctx }) => {
    // Call Better Auth API - it returns a Response with Set-Cookie headers
    const headers = ctx.request.headers;
    const response = await auth.api.signInEmail({
      body: input,
      headers,
      asResponse: true,
    });

    // Extract Set-Cookie headers and add them to the tRPC response context
    const setCookieHeader = response.headers.get("set-cookie");
    if (setCookieHeader && ctx.responseHeaders) {
      // Add Set-Cookie headers to the response
      ctx.responseHeaders.set("set-cookie", setCookieHeader);
    }

    // Parse and return the response body
    const result = await response.json();
    return result;
  }),

  signUp: publicProcedure
    .input(SignUpSchema)
    .mutation(async ({ input, ctx }) => {
      if (!isStagingAuthEnabled()) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Sign ups are disabled.",
        });
      }

      // Call Better Auth API - it returns a Response with Set-Cookie headers
      const headers = ctx.request.headers;
      const response = await auth.api.signUpEmail({
        body: input,
        headers,
        asResponse: true,
      });

      // Extract Set-Cookie headers and add them to the tRPC response context
      const setCookieHeader = response.headers.get("set-cookie");
      if (setCookieHeader && ctx.responseHeaders) {
        // Add Set-Cookie headers to the response
        ctx.responseHeaders.set("set-cookie", setCookieHeader);
      }

      // Parse and return the response body
      const result = await response.json();

      if (response.ok && shouldAutoAdminSignUps()) {
        await ctx.db
          .update(user)
          .set({ isAdmin: true })
          .where(eq(user.email, input.email));
      }

      return result;
    }),

  logout: protectedProcedure.mutation(async ({ ctx }) => {
    // Call Better Auth API - it returns a Response with Set-Cookie headers to clear cookies
    const headers = ctx.request.headers;
    const response = await auth.api.signOut({
      headers,
      asResponse: true,
    });

    // Extract Set-Cookie headers and add them to the tRPC response context
    const setCookieHeader = response.headers.get("set-cookie");
    if (setCookieHeader && ctx.responseHeaders) {
      // Add Set-Cookie headers to the response
      ctx.responseHeaders.set("set-cookie", setCookieHeader);
    }

    return { success: true };
  }),

  getSession: publicProcedure.query(async ({ ctx }) => {
    // Return the current session
    const headers = ctx.request.headers;
    const session = await ensureStagingAdminSession(
      await auth.api.getSession({
        headers,
      }),
    );

    return session;
  }),
} satisfies TRPCRouterRecord;

// src/functions.ts

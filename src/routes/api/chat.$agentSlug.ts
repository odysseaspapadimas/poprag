/**
 * Chat API endpoint
 * POST /api/chat/$agentSlug
 *
 * Supports Firebase ID token authentication via Authorization header.
 * When a valid token is provided, the Firebase user is tracked for metrics.
 */

import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { firebaseUser } from "@/db/schema";
import { handleChatRequest } from "@/lib/ai/chat";
import {
  extractBearerToken,
  type VerifiedFirebaseUser,
  verifyFirebaseToken,
} from "@/lib/firebase/verify-token";

const chatRequestSchema = z.object({
  messages: z.array(z.any()), // UIMessage[]
  modelAlias: z.string().optional(),
  variables: z.record(z.string(), z.unknown()).optional(),
  rag: z
    .object({
      enabled: z.boolean().optional(),
      topK: z.number().optional(),
      filters: z.record(z.string(), z.unknown()).optional(),
      rewriteQuery: z.boolean().optional(),
      rewriteModel: z.string().optional(),
      rerank: z.boolean().optional(),
      rerankModel: z.string().optional(),
    })
    .optional(),
  conversationId: z.string().optional(),
  initiatedBy: z.string().optional(),
  experienceSlug: z.string().optional(),
});

/**
 * Resolve Firebase user from request Authorization header.
 * Verifies the Bearer token and upserts the user for tracking.
 * Returns null if no token is present or verification fails.
 */
async function resolveFirebaseUser(
  request: Request,
): Promise<VerifiedFirebaseUser | null> {
  const authHeader = request.headers.get("Authorization");
  console.log(
    "[Firebase Auth] Authorization header:",
    authHeader ? `present (${authHeader.slice(0, 20)}...)` : "missing",
  );

  const token = extractBearerToken(authHeader);
  if (!token) {
    console.warn(
      "[Firebase Auth] No Bearer token extracted — header is missing or not in 'Bearer <token>' format",
    );
    return null;
  }
  console.log("[Firebase Auth] Bearer token extracted, length:", token.length);

  const serviceAccountData = process.env.SERVICE_ACCOUNT_DATA;
  if (!serviceAccountData) {
    console.error(
      "[Firebase Auth] SERVICE_ACCOUNT_DATA env var is not set — cannot verify token",
    );
    return null;
  }

  try {
    const decoded = Buffer.from(serviceAccountData, "base64").toString("utf-8");
    const { project_id } = JSON.parse(decoded) as { project_id: string };
    console.log("[Firebase Auth] Verifying token against project:", project_id);

    const userData = await verifyFirebaseToken(token, project_id);

    if (!userData) {
      console.warn(
        "[Firebase Auth] Token verification returned null — see [Firebase Auth] logs above for the specific failure",
      );
      return null;
    }

    console.log(
      `[Firebase Auth] Token verified OK: uid=${userData.uid} email=${userData.email} provider=${userData.signInProvider}`,
    );

    upsertFirebaseUser(userData).catch((err) => {
      console.error("[Chat API] Background user upsert failed:", err);
    });

    return userData;
  } catch (err) {
    console.error(
      "[Firebase Auth] Unexpected error during token verification:",
      err,
    );
    return null;
  }
}

/**
 * Upsert Firebase user in the database
 * Creates new record or updates existing with latest info from token
 */
async function upsertFirebaseUser(user: VerifiedFirebaseUser): Promise<void> {
  const now = new Date();

  try {
    // Check if user exists
    const [existing] = await db
      .select()
      .from(firebaseUser)
      .where(eq(firebaseUser.uid, user.uid))
      .limit(1);

    if (existing) {
      // Update existing user
      await db
        .update(firebaseUser)
        .set({
          email: user.email,
          displayName: user.displayName,
          photoUrl: user.photoUrl,
          signInProvider: user.signInProvider,
          lastSeenAt: now,
          totalRequests: existing.totalRequests + 1,
        })
        .where(eq(firebaseUser.uid, user.uid));
    } else {
      // Create new user
      await db.insert(firebaseUser).values({
        uid: user.uid,
        email: user.email,
        displayName: user.displayName,
        photoUrl: user.photoUrl,
        signInProvider: user.signInProvider,
        firstSeenAt: now,
        lastSeenAt: now,
        totalRequests: 1,
      });
    }

    console.log(
      `[Chat API] Firebase user upserted: ${user.uid} (${user.email})`,
    );
  } catch (error) {
    // Log but don't fail the request if user tracking fails
    console.error("[Chat API] Failed to upsert Firebase user:", error);
  }
}

class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

function validateChatPayload(payload: z.infer<typeof chatRequestSchema>) {
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    throw new BadRequestError("Messages array cannot be empty.");
  }

  const lastMessage = payload.messages[payload.messages.length - 1] as
    | { role?: string; parts?: Array<Record<string, unknown>> }
    | undefined;

  if (!lastMessage || lastMessage.role !== "user") {
    throw new BadRequestError(
      "Last message must be a user message. Remove empty assistant placeholders.",
    );
  }

  const parts = Array.isArray(lastMessage.parts) ? lastMessage.parts : [];
  const hasText = parts.some(
    (part) =>
      part?.type === "text" &&
      typeof part.text === "string" &&
      part.text.trim().length > 0,
  );
  const hasImage = parts.some(
    (part) =>
      part?.type === "image" &&
      typeof part.image === "string" &&
      part.image.length > 0,
  );

  if (!hasText && !hasImage) {
    throw new BadRequestError("Last user message must include text or image.");
  }
}

export const Route = createFileRoute("/api/chat/$agentSlug")({
  server: {
    handlers: {
      OPTIONS: ({ request }) => {
        const origin = request.headers.get("Origin") || "*";
        return new Response(null, {
          status: 200,
          headers: {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            Vary: "Origin",
          },
        });
      },

      POST: async ({ request, params }) => {
        const origin = request.headers.get("Origin") || "*";
        const corsHeaders = {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          Vary: "Origin",
        };
        try {
          const body = await request.json();
          const validated = chatRequestSchema.parse(body);

          console.log("[Chat API] Request payload:", validated);
          validateChatPayload(validated);

          // Access Cloudflare Workers environment and execution context
          const { env, waitUntil } = await import("cloudflare:workers");

          // Verify Firebase ID token if provided
          const firebaseUserData = await resolveFirebaseUser(request);

          // Handle chat request
          // Experience slug: prefer body (from sendMessage per-request options)
          // with URL param fallback (for external API consumers)
          const url = new URL(request.url);
          const experienceSlug =
            validated.experienceSlug ||
            url.searchParams.get("experience") ||
            null;

          const result = await handleChatRequest(
            {
              agentSlug: params.agentSlug,
              experienceSlug,
              ...validated,
              // Pass Firebase UID for tracking in transcripts/metrics
              firebaseUid: firebaseUserData?.uid,
            },
            env,
            waitUntil,
          );

          console.log(
            "[Chat API] Dispatching handleChatRequest:",
            `agentSlug=${params.agentSlug}`,
            `firebaseUid=${firebaseUserData?.uid ?? "none"}`,
            `initiatedBy=${validated.initiatedBy ?? "none"}`,
          );

          const response = result.toUIMessageStreamResponse();
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: {
              ...Object.fromEntries(response.headers.entries()),
              ...corsHeaders,
            },
          });
        } catch (error) {
          console.error("Chat API error:", error);

          if (error instanceof z.ZodError) {
            return new Response(
              JSON.stringify({
                error: "Invalid request",
                details: error.issues,
              }),
              {
                status: 400,
                headers: {
                  "Content-Type": "application/json",
                  ...corsHeaders,
                },
              },
            );
          }

          if (error instanceof BadRequestError) {
            return new Response(
              JSON.stringify({
                error: error.message,
              }),
              {
                status: 400,
                headers: {
                  "Content-Type": "application/json",
                  ...corsHeaders,
                },
              },
            );
          }

          return new Response(
            JSON.stringify({
              error:
                error instanceof Error
                  ? error.message
                  : "Internal server error",
            }),
            {
              status: 500,
              headers: {
                "Content-Type": "application/json",
                ...corsHeaders,
              },
            },
          );
        }
      },
    },
  },
});

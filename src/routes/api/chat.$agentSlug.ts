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
});

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

          // Access Cloudflare Workers environment
          const { env } = await import("cloudflare:workers");

          // Verify Firebase ID token if provided
          let firebaseUserData: VerifiedFirebaseUser | null = null;
          const authHeader = request.headers.get("Authorization");
          const token = extractBearerToken(authHeader);

          if (token) {
            // Get Firebase project ID from service account
            const serviceAccountData = process.env.SERVICE_ACCOUNT_DATA;
            if (serviceAccountData) {
              try {
                const decoded = Buffer.from(
                  serviceAccountData,
                  "base64",
                ).toString("utf-8");
                const serviceAccount = JSON.parse(decoded) as {
                  project_id: string;
                };
                firebaseUserData = await verifyFirebaseToken(
                  token,
                  serviceAccount.project_id,
                );

                if (firebaseUserData) {
                  // Upsert user for tracking (don't await to avoid blocking)
                  upsertFirebaseUser(firebaseUserData).catch((err) => {
                    console.error(
                      "[Chat API] Background user upsert failed:",
                      err,
                    );
                  });
                } else {
                  console.warn("[Chat API] Invalid Firebase token provided");
                }
              } catch (err) {
                console.error(
                  "[Chat API] Failed to verify Firebase token:",
                  err,
                );
              }
            }
          }

          // Handle chat request
          const result = await handleChatRequest(
            {
              agentSlug: params.agentSlug,
              ...validated,
              // Pass Firebase UID for tracking in transcripts/metrics
              firebaseUid: firebaseUserData?.uid,
            },
            env,
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

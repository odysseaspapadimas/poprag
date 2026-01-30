/**
 * Chat API endpoint
 * POST /api/chat/$agentSlug
 */

import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { handleChatRequest } from "@/lib/ai/chat";

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
            "Access-Control-Allow-Headers": "Content-Type",
            Vary: "Origin",
          },
        });
      },

      POST: async ({ request, params }) => {
        const origin = request.headers.get("Origin") || "*";
        const corsHeaders = {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          Vary: "Origin",
        };
        try {
          const body = await request.json();
          const validated = chatRequestSchema.parse(body);

          console.log("[Chat API] Request payload:", validated);
          validateChatPayload(validated);

          // Access Cloudflare Workers environment
          const { env } = await import("cloudflare:workers");

          // Handle chat request
          const result = await handleChatRequest(
            {
              agentSlug: params.agentSlug,
              ...validated,
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

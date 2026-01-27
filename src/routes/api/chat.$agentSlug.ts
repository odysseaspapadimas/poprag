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
      query: z.string().optional(),
      topK: z.number().optional(),
      filters: z.record(z.string(), z.unknown()).optional(),
      rewriteQuery: z.boolean().optional(),
      rewriteModel: z.string().optional(),
      rerank: z.boolean().optional(),
      rerankModel: z.string().optional(),
    })
    .optional(),
  conversationId: z.string().optional(),
});

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

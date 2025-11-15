/**
 * Chat API endpoint
 * POST /api/chat/$agentSlug
 */

import { handleChatRequest } from "@/lib/ai/chat";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const chatRequestSchema = z.object({
  messages: z.array(z.any()), // UIMessage[]
  modelAlias: z.string().optional(),
  variables: z.record(z.string(), z.unknown()).optional(),
  rag: z
    .object({
      query: z.string().optional(),
      topK: z.number().optional(),
      filters: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  requestTags: z.array(z.string()).optional(),
});

export const Route = createFileRoute("/api/chat/$agentSlug")({
  server: {
    handlers: {
      OPTIONS: () => {
        return new Response(null, {
          status: 200,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        });
      },

      POST: async ({ request, params }) => {
        try {
          const body = await request.json();
          const validated = chatRequestSchema.parse(body);

          // Get environment variables
          const env = {
            OPENAI_API_KEY: process.env.OPENAI_API_KEY,
            OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
            CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
          };

          // Handle chat request
          const result = await handleChatRequest({ agentSlug: params.agentSlug, ...validated }, { env });

          // Return streaming response
          return result.toUIMessageStreamResponse();
        } catch (error) {
          console.error("Chat API error:", error);

          if (error instanceof z.ZodError) {
            return new Response(
              JSON.stringify({
                error: "Invalid request",
                details: error.issues,
              }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            );
          }

          return new Response(
            JSON.stringify({
              error:
                error instanceof Error
                  ? error.message
                  : "Internal server error",
            }),
            { status: 500, headers: { "Content-Type": "application/json" } }
          );
        }
      },
    },
  },
});
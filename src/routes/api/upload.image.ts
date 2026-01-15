/**
 * Image Upload API endpoint (for Flutter/mobile clients)
 * POST /api/upload/image
 *
 * This provides a direct HTTP endpoint for uploading images,
 * bypassing tRPC for mobile client compatibility.
 */

import { createFileRoute } from "@tanstack/react-router";
import { AwsClient } from "aws4fetch";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "@/db";
import { chatImage } from "@/db/schema";

const uploadRequestSchema = z.object({
  agentSlug: z.string(),
  conversationId: z.string().optional(),
  fileName: z.string(),
  mime: z.string(),
});

export const Route = createFileRoute("/api/upload/image")({
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

      /**
       * Handle multipart form-data image upload
       * Returns imageId and downloadUrl for use in chat messages
       */
      POST: async ({ request }) => {
        try {
          const contentType = request.headers.get("content-type") || "";

          // Check if it's a multipart form-data request
          if (!contentType.includes("multipart/form-data")) {
            return new Response(
              JSON.stringify({
                error: "Content-Type must be multipart/form-data",
              }),
              {
                status: 400,
                headers: {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": "*",
                },
              },
            );
          }

          const formData = await request.formData();

          // Get file from form data
          const file = formData.get("file") as File | null;
          const agentSlug = formData.get("agentSlug") as string | null;
          const conversationId =
            (formData.get("conversationId") as string) || nanoid();

          if (!file) {
            return new Response(JSON.stringify({ error: "No file provided" }), {
              status: 400,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            });
          }

          if (!agentSlug) {
            return new Response(
              JSON.stringify({ error: "agentSlug is required" }),
              {
                status: 400,
                headers: {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": "*",
                },
              },
            );
          }

          // Validate file type
          const allowedMimes = [
            "image/jpeg",
            "image/png",
            "image/webp",
            "image/gif",
          ];
          if (!allowedMimes.includes(file.type)) {
            return new Response(
              JSON.stringify({
                error:
                  "Unsupported image type. Only JPEG, PNG, WebP, and GIF are allowed.",
              }),
              {
                status: 400,
                headers: {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": "*",
                },
              },
            );
          }

          // Validate file size (10MB max for mobile uploads)
          const maxSize = 10 * 1024 * 1024;
          if (file.size > maxSize) {
            return new Response(
              JSON.stringify({
                error: "Image too large. Maximum size is 10MB.",
              }),
              {
                status: 400,
                headers: {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": "*",
                },
              },
            );
          }

          // Resolve agent by slug to get agentId
          const { agent } = await import("@/db/schema");
          const { eq } = await import("drizzle-orm");

          const [agentRecord] = await db
            .select()
            .from(agent)
            .where(eq(agent.slug, agentSlug))
            .limit(1);

          if (!agentRecord) {
            return new Response(
              JSON.stringify({ error: `Agent '${agentSlug}' not found` }),
              {
                status: 404,
                headers: {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": "*",
                },
              },
            );
          }

          // Create chat image record
          const imageId = nanoid();
          const fileName = file.name || `image_${imageId}`;
          const r2Key = `agents/${agentRecord.id}/chat/${conversationId}/images/${imageId}/${fileName}`;

          // Access Cloudflare Workers environment
          const { env } = await import("cloudflare:workers");

          // Upload directly to R2
          const arrayBuffer = await file.arrayBuffer();
          await env.R2.put(r2Key, arrayBuffer, {
            httpMetadata: {
              contentType: file.type,
            },
          });

          // Insert record into database
          // Note: For public API, we use a system user ID or make createdBy optional
          await db.insert(chatImage).values({
            id: imageId,
            agentId: agentRecord.id,
            conversationId,
            r2Bucket: "poprag",
            r2Key,
            fileName,
            mime: file.type,
            bytes: file.size,
            createdBy: "system", // For unauthenticated mobile uploads
          });

          // Generate a signed GET URL for downloading the image
          const aws = new AwsClient({
            accessKeyId: env.R2_ACCESS_KEY_ID,
            secretAccessKey: env.R2_SECRET_ACCESS_KEY,
          });

          const getUrl = new URL(
            `https://poprag.${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${r2Key}`,
          );
          getUrl.searchParams.set("X-Amz-Expires", "86400"); // 24 hours

          const getRequest = new Request(getUrl, {
            method: "GET",
          });

          const signedGetRequest = await aws.sign(getRequest, {
            aws: { signQuery: true },
          });

          return new Response(
            JSON.stringify({
              id: imageId,
              url: signedGetRequest.url,
              fileName,
              mime: file.type,
              bytes: file.size,
            }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            },
          );
        } catch (error) {
          console.error("Image upload error:", error);

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
                "Access-Control-Allow-Origin": "*",
              },
            },
          );
        }
      },
    },
  },
});

/**
 * Knowledge file upload API endpoint
 * POST /api/upload-knowledge
 */

import { db } from "@/db";
import { knowledgeSource } from "@/db/schema";
import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import crypto from "crypto";
import { eq } from "drizzle-orm";

export const Route = createFileRoute("/api/upload-knowledge/$")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const formData = await request.formData();
          const file = formData.get('file') as File;
          const sourceId = formData.get('sourceId') as string;

          if (!file || !sourceId) {
            return new Response(
              JSON.stringify({ error: "Missing file or sourceId" }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            );
          }

          // Verify the knowledge source exists and is in the right state
          const [source] = await db
            .select()
            .from(knowledgeSource)
            .where(eq(knowledgeSource.id, sourceId))
            .limit(1);

          if (!source) {
            return new Response(
              JSON.stringify({ error: "Knowledge source not found" }),
              { status: 404, headers: { "Content-Type": "application/json" } }
            );
          }

          if (source.status !== 'uploaded') {
            return new Response(
              JSON.stringify({ error: "Source is not in uploadable state" }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            );
          }

          // Read file content
          const fileBuffer = Buffer.from(await file.arrayBuffer());

          // Calculate checksum
          const checksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');

          // Upload to R2
          const r2Key = source.r2Key!;
          await env.R2.put(r2Key, fileBuffer, {
            httpMetadata: {
              contentType: file.type || 'application/octet-stream',
            },
            customMetadata: {
              sourceId,
              fileName: file.name,
              checksum,
              uploadedAt: new Date().toISOString(),
            },
          });

          // Update the knowledge source with checksum and status
          await db
            .update(knowledgeSource)
            .set({
              checksum,
              status: 'uploaded',
              updatedAt: new Date(),
            })
            .where(eq(knowledgeSource.id, sourceId));

          return new Response(
            JSON.stringify({
              success: true,
              checksum,
              sourceId,
              fileName: file.name,
              size: file.size,
              r2Key,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );

        } catch (error) {
          console.error("Upload API error:", error);
          return new Response(
            JSON.stringify({
              error: error instanceof Error ? error.message : "Upload failed",
            }),
            { status: 500, headers: { "Content-Type": "application/json" } }
          );
        }
      },
    },
  },
});
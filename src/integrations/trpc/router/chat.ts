import { AwsClient } from "aws4fetch";
import { desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "@/db";
import { chatImage, transcript } from "@/db/schema";
import { audit, requireAgent } from "@/integrations/trpc/helpers";
import { createTRPCRouter, protectedProcedure } from "@/integrations/trpc/init";

/**
 * Chat management router
 */
export const chatRouter = createTRPCRouter({
  /**
   * Initiate image upload for chat
   * Returns upload configuration for client-side upload
   */
  uploadImageStart: protectedProcedure
    .input(
      z.object({
        agentId: z.string(),
        conversationId: z.string(),
        fileName: z.string(),
        mime: z.string(),
        bytes: z.number(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      try {
        // Verify agent exists
        await requireAgent(input.agentId);

        // Validate file type and size
        const allowedMimes = [
          "image/jpeg",
          "image/png",
          "image/webp",
          "image/gif",
        ];
        if (!allowedMimes.includes(input.mime)) {
          throw new Error(
            "Unsupported image type. Only JPEG, PNG, WebP, and GIF are allowed.",
          );
        }

        const maxSize = 5 * 1024 * 1024; // 5MB
        if (input.bytes > maxSize) {
          throw new Error("Image too large. Maximum size is 5MB.");
        }

        // Create chat image record with agent-scoped R2 key
        const imageId = nanoid();
        const r2Key = `agents/${input.agentId}/chat/${input.conversationId}/images/${imageId}/${input.fileName}`;

        await db.insert(chatImage).values({
          id: imageId,
          agentId: input.agentId,
          conversationId: input.conversationId,
          r2Bucket: "poprag", // Match wrangler.jsonc bucket name
          r2Key,
          fileName: input.fileName,
          mime: input.mime,
          bytes: input.bytes,
          createdBy: ctx.session.user.id,
        });

        // Generate R2 presigned URL for direct upload
        const { env } = await import("cloudflare:workers");

        // Create AWS4 client for R2 with credentials from environment
        const aws = new AwsClient({
          accessKeyId: env.R2_ACCESS_KEY_ID,
          secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        });

        // Build the R2 URL following Cloudflare's format: https://{bucket}.{accountId}.r2.cloudflarestorage.com/{key}
        const url = new URL(
          `https://poprag.${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${r2Key}`,
        );

        // Set expiry in search params (as per Cloudflare docs)
        url.searchParams.set("X-Amz-Expires", "3600"); // 1 hour

        // Create the request to sign
        const request = new Request(url, {
          method: "PUT",
          headers: {
            "Content-Type": input.mime,
          },
        });

        // Sign the request with query parameters (generates presigned URL)
        const signedRequest = await aws.sign(request, {
          aws: { signQuery: true },
        });

        const uploadUrl = signedRequest.url;

        // Generate a signed GET URL for downloading the image (short-lived)
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

        const downloadUrl = signedGetRequest.url;

        return {
          imageId,
          uploadUrl,
          downloadUrl,
          r2Key,
        };
      } catch (error) {
        console.error("Error in uploadImageStart:", error);
        throw error;
      }
    }),

  /**
   * Confirm image upload
   */
  confirmImageUpload: protectedProcedure
    .input(
      z.object({
        imageId: z.string(),
        checksum: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const [image] = await db
        .select()
        .from(chatImage)
        .where(eq(chatImage.id, input.imageId))
        .limit(1);

      if (!image) {
        throw new Error("Image not found");
      }

      // Verify user has access to the agent
      await requireAgent(image.agentId);

      // Update checksum if provided
      if (input.checksum) {
        await db
          .update(chatImage)
          .set({
            // checksum: input.checksum, // Add checksum column if needed
            updatedAt: new Date(),
          })
          .where(eq(chatImage.id, input.imageId));
      }

      // Audit log
      await audit(
        ctx,
        "chat.image_uploaded",
        { type: "chat_image", id: input.imageId },
        {
          fileName: image.fileName,
        },
      );

      return { success: true };
    }),

  /**
   * Delete chat image
   */
  deleteImage: protectedProcedure
    .input(z.object({ imageId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const [image] = await db
        .select()
        .from(chatImage)
        .where(eq(chatImage.id, input.imageId))
        .limit(1);

      if (!image) {
        throw new Error("Image not found");
      }

      // Verify user has access to the agent
      await requireAgent(image.agentId);

      // Delete from R2
      const { env } = await import("cloudflare:workers");
      if (image.r2Key) {
        await env.R2.delete(image.r2Key);
      }

      // Delete from DB
      await db.delete(chatImage).where(eq(chatImage.id, input.imageId));

      // Audit log
      await audit(
        ctx,
        "chat.image_deleted",
        { type: "chat_image", id: input.imageId },
        {
          fileName: image.fileName,
        },
      );

      return { success: true };
    }),

  /**
   * Get RAG debug info for a transcript
   */
  getRAGDebugInfo: protectedProcedure
    .input(
      z.object({
        runId: z.string().optional(),
        conversationId: z.string().optional(),
      }),
    )
    .query(async ({ input }) => {
      if (!input.runId && !input.conversationId) {
        throw new Error("Must provide either runId or conversationId");
      }

      const [latestTranscript] = await db
        .select()
        .from(transcript)
        .where(
          input.runId
            ? eq(transcript.runId, input.runId)
            : eq(transcript.conversationId, input.conversationId!),
        )
        .orderBy(desc(transcript.createdAt))
        .limit(1);

      if (!latestTranscript) {
        return null;
      }

      // Extract RAG debug info from request
      const request = latestTranscript.request as Record<string, unknown>;
      const ragDebug = request.ragDebug as any;

      return ragDebug || null;
    }),
});

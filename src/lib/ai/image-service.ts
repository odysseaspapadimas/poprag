/**
 * Chat Image Service
 * Handles image fetching, processing, and validation for multimodal chat
 */

import type { LanguageModel } from "ai";
import { generateText } from "ai";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { chatImage } from "@/db/schema";
import { type ModelCapabilities, supportsModality } from "./helpers";

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────

export interface ImagePayload {
  type: "file";
  mediaType: string;
  url: string;
}

export interface SkippedImagePayload {
  type: "text";
  text: string;
}

export type ProcessedImagePart = ImagePayload | SkippedImagePayload;

export interface ImagePartInput {
  type: "image";
  image:
    | string
    | {
        id?: string;
        url?: string;
        fileName?: string;
        mime?: string;
        bytes?: number;
      };
}

// ─────────────────────────────────────────────────────
// Image Processing
// ─────────────────────────────────────────────────────

/**
 * Fetch an image from R2 and convert to base64 data URL
 *
 * @param imageId - The chat image ID
 * @param env - Cloudflare environment with R2 binding
 * @returns Base64 data URL for the image
 * @throws Error if image not found
 */
export async function fetchImageAsBase64(
  imageId: string,
  env: { R2: R2Bucket },
): Promise<{ dataUrl: string; mime: string }> {
  // Fetch image metadata from database
  const [imageRecord] = await db
    .select()
    .from(chatImage)
    .where(eq(chatImage.id, imageId))
    .limit(1);

  if (!imageRecord || !imageRecord.r2Key) {
    throw new Error(`Image not found: ${imageId}`);
  }

  // Fetch image from R2
  const r2Object = await env.R2.get(imageRecord.r2Key);

  if (!r2Object) {
    throw new Error(`Image not found in R2: ${imageRecord.r2Key}`);
  }

  // Convert to base64
  const arrayBuffer = await r2Object.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  const mime = imageRecord.mime || "image/png";

  return {
    dataUrl: `data:${mime};base64,${base64}`,
    mime,
  };
}

/**
 * Process an image part for model consumption
 * Handles capability checking and base64 conversion
 *
 * @param imagePart - The image part from the message
 * @param modelCapabilities - Capabilities of the target model
 * @param modelAlias - Model alias for logging
 * @param env - Cloudflare environment with R2 binding
 * @returns Processed image payload or skipped text
 */
export async function processImagePart(
  imagePart: ImagePartInput,
  modelCapabilities: ModelCapabilities | null,
  modelAlias: string,
  env: { R2: R2Bucket },
): Promise<ProcessedImagePart> {
  const supportsImage = supportsModality(modelCapabilities, "image");

  if (!supportsImage) {
    console.log(
      `[Image Service] Skipping image - model '${modelAlias}' does not support image input`,
    );
    return {
      type: "text",
      text: "[Image attachment skipped - selected model does not support image input]",
    };
  }

  const inlineDataUrl = resolveInlineDataUrl(imagePart.image);
  if (inlineDataUrl) {
    return {
      type: "file",
      mediaType: getMimeFromDataUrl(inlineDataUrl) || "image/png",
      url: inlineDataUrl,
    };
  }

  const imageId = resolveImageId(imagePart.image);
  if (!imageId) {
    return {
      type: "text",
      text: "[Image attachment skipped - missing image reference]",
    };
  }

  const { dataUrl, mime } = await fetchImageAsBase64(imageId, env);

  return {
    type: "file",
    mediaType: mime,
    url: dataUrl,
  };
}

/**
 * Check if a message part is an image part
 */
export function isImagePart(part: unknown): part is ImagePartInput {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    "image" in part &&
    (part as { type: string }).type === "image"
  );
}

function resolveInlineDataUrl(image: ImagePartInput["image"]): string | null {
  if (typeof image === "string") {
    return isDataUrl(image) ? image : null;
  }

  if (image && typeof image === "object" && typeof image.url === "string") {
    return isDataUrl(image.url) ? image.url : null;
  }

  return null;
}

function resolveImageId(image: ImagePartInput["image"]): string | null {
  if (image && typeof image === "object" && typeof image.id === "string") {
    return image.id;
  }
  return null;
}

function isDataUrl(value: string): boolean {
  return value.startsWith("data:");
}

function getMimeFromDataUrl(value: string): string | null {
  if (!value.startsWith("data:")) return null;
  const match = /^data:([^;]+);base64,/.exec(value);
  return match?.[1] ?? null;
}

/**
 * Process all parts in a message, handling images appropriately
 *
 * @param parts - Message parts to process
 * @param modelCapabilities - Capabilities of the target model
 * @param modelAlias - Model alias for logging
 * @param env - Cloudflare environment with R2 binding
 * @returns Processed parts array
 */
export async function processMessageParts(
  parts: unknown[],
  modelCapabilities: ModelCapabilities | null,
  modelAlias: string,
  env: { R2: R2Bucket },
): Promise<unknown[]> {
  const processedParts = await Promise.all(
    parts.map(async (part) => {
      if (isImagePart(part)) {
        return processImagePart(part, modelCapabilities, modelAlias, env);
      }
      return part;
    }),
  );

  return processedParts.filter(Boolean);
}

// ─────────────────────────────────────────────────────
// Image Context Extraction for RAG
// ─────────────────────────────────────────────────────

/**
 * Extract visual context from image parts using a vision-capable model.
 * Used to enhance RAG queries with information visible in attached images
 * (e.g., product names, brands, text on packaging).
 *
 * Only processes the first image in the message to keep latency low.
 *
 * @param messageParts - The parts of the last user message
 * @param model - A vision-capable language model
 * @param env - Cloudflare environment with R2 binding
 * @returns Extracted text description, or null if no images or extraction fails
 */
export async function extractImageContextForRAG(
  messageParts: unknown[],
  model: LanguageModel,
  env: { R2: R2Bucket },
): Promise<string | null> {
  // Find image parts
  const imageParts = messageParts.filter(isImagePart);
  if (imageParts.length === 0) return null;

  // Resolve the first image to a data URL
  const firstImage = imageParts[0];
  let dataUrl: string | null = resolveInlineDataUrl(firstImage.image);

  // Fall back to R2 fetch (dashboard client stores images in R2)
  if (!dataUrl) {
    const imageId = resolveImageId(firstImage.image);
    if (imageId) {
      try {
        const result = await fetchImageAsBase64(imageId, env);
        dataUrl = result.dataUrl;
      } catch (error) {
        console.warn("[Image Context] Failed to fetch image from R2:", error);
        return null;
      }
    }
  }

  if (!dataUrl) return null;

  try {
    const { text } = await generateText({
      model,
      messages: [
        {
          role: "user" as const,
          content: [
            {
              type: "image" as const,
              image: dataUrl,
            },
            {
              type: "text" as const,
              text: "Extract all visible text, product names, brands, quantities, and key details from this image. Return ONLY a concise factual description with the extracted information. No commentary or explanation.",
            },
          ],
        },
      ],
      temperature: 0,
      maxOutputTokens: 200,
      abortSignal: AbortSignal.timeout(8000),
    });

    const description = text.trim();
    if (!description) return null;

    console.log(
      `[Image Context] Extracted: "${description.substring(0, 100)}${description.length > 100 ? "..." : ""}"`,
    );

    return description;
  } catch (error) {
    const isTimeout =
      error instanceof DOMException && error.name === "AbortError";
    console.warn(
      `[Image Context] Vision extraction ${isTimeout ? "timed out (8s)" : "failed"}:`,
      error,
    );
    return null;
  }
}

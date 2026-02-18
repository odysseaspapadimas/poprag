/**
 * Vectorize utility functions and validation
 * Helps diagnose issues with Cloudflare Vectorize setup
 */

/**
 * Check Vectorize index health and configuration
 * Use this to debug "incomplete results" issues
 */
export async function checkVectorizeHealth(namespace?: string) {
  try {
    const { env } = await import("cloudflare:workers");

    if (!env.VECTORIZE) {
      return {
        status: "error",
        message: "VECTORIZE binding not available",
      };
    }

    // Get index info
    const indexInfo = await env.VECTORIZE.describe();

    console.log("[Vectorize Health Check]", {
      dimensions: indexInfo.dimensions,
      vectorCount: indexInfo.vectorCount,
      processedUpToMutation: indexInfo.processedUpToMutation,
      namespace: namespace || "all",
    });

    return {
      status: "healthy",
      dimensions: indexInfo.dimensions,
      vectorCount: indexInfo.vectorCount,
      processedUpToMutation: indexInfo.processedUpToMutation,
    };
  } catch (error) {
    console.error("[Vectorize Health Check] Failed:", error);
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Test query to validate Vectorize is working
 * Returns sample results from a namespace
 */
export async function testVectorizeQuery(
  namespace: string,
  sampleQuery: string,
) {
  try {
    const { env } = await import("cloudflare:workers");
    const { generateEmbedding } = await import("./embedding");

    const queryEmbedding = await generateEmbedding(sampleQuery);

    const results = await env.VECTORIZE.query(queryEmbedding, {
      namespace,
      topK: 3,
      returnValues: false,
      returnMetadata: "all",
    });

    console.log("[Vectorize Test Query]", {
      namespace,
      query: sampleQuery,
      resultsCount: results.matches?.length || 0,
      hasMetadata: results.matches?.[0]?.metadata ? true : false,
      metadataKeys: results.matches?.[0]?.metadata
        ? Object.keys(results.matches[0].metadata)
        : [],
    });

    return {
      status: "success",
      resultsCount: results.matches?.length || 0,
      sampleMatch: results.matches?.[0]
        ? {
            id: results.matches[0].id,
            score: results.matches[0].score,
            metadataKeys: Object.keys(results.matches[0].metadata || {}),
            sourceId: results.matches[0].metadata?.sourceId,
            fileName: results.matches[0].metadata?.fileName,
          }
        : null,
    };
  } catch (error) {
    console.error("[Vectorize Test Query] Failed:", error);
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Validate metadata size before inserting
 * Cloudflare Vectorize has a 3KB limit per vector metadata
 */
export function validateMetadataSize(metadata: Record<string, any>): {
  valid: boolean;
  size: number;
  message?: string;
} {
  const jsonSize = JSON.stringify(metadata).length;
  const MAX_SIZE = 3072; // 3KB

  if (jsonSize > MAX_SIZE) {
    return {
      valid: false,
      size: jsonSize,
      message: `Metadata size ${jsonSize} bytes exceeds Vectorize limit of ${MAX_SIZE} bytes`,
    };
  }

  return {
    valid: true,
    size: jsonSize,
  };
}

/**
 * List all vectors in a namespace (for debugging)
 * Note: This uses a dummy query to get all vectors
 */
export async function listNamespaceVectors(namespace: string, limit = 10) {
  try {
    const { env } = await import("cloudflare:workers");
    const { EMBEDDING_CONFIG } = await import("@/lib/ai/constants");

    // Create a zero vector for listing (matches all with low scores)
    const zeroVector = new Array(EMBEDDING_CONFIG.DIMENSIONS).fill(0);

    const results = await env.VECTORIZE.query(zeroVector, {
      namespace,
      topK: limit,
      returnValues: false,
      returnMetadata: "all",
    });

    return {
      status: "success",
      count: results.matches?.length || 0,
      vectors:
        results.matches?.map((m) => ({
          id: m.id,
          hasMetadata: !!m.metadata,
          sourceId: m.metadata?.sourceId,
          fileName: m.metadata?.fileName,
        })) || [],
    };
  } catch (error) {
    console.error("[List Namespace Vectors] Failed:", error);
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

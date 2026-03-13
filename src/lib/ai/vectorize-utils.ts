/**
 * Vectorize utility functions and validation
 * Helps diagnose issues with Cloudflare Vectorize setup
 */

import { env } from "cloudflare:workers";
import { EMBEDDING_CONFIG, VECTORIZE_CONFIG } from "@/lib/ai/constants";
import {
  generateEmbedding,
  getSourceIdFilterSupportSnapshot,
} from "@/lib/ai/embedding";

type VectorizeDiagnosticMode =
  | "namespace-only"
  | "filtered-by-source"
  | "broad-post-filter";

function getSourceIdMetadataIndexConfigured(): boolean | null {
  return true;
}

/**
 * Check Vectorize index health and configuration
 * Use this to debug "incomplete results" issues
 */
export async function checkVectorizeHealth(namespace?: string) {
  try {
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
      indexName: VECTORIZE_CONFIG.INDEX_NAME,
      dimensions: indexInfo.dimensions,
      vectorCount: indexInfo.vectorCount,
      processedUpToMutation: indexInfo.processedUpToMutation,
      processedUpToDatetime: indexInfo.processedUpToDatetime,
      sourceIdMetadataIndexConfigured: getSourceIdMetadataIndexConfigured(),
      sourceIdFilterCapability: "available" as const,
      namespaceCapabilityCache: getSourceIdFilterSupportSnapshot(),
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
  options?: {
    sourceId?: string;
    topK?: number;
    mode?: VectorizeDiagnosticMode;
  },
) {
  try {
    const queryEmbedding = await generateEmbedding(sampleQuery);
    const topK = options?.topK ?? 3;
    const mode = options?.mode ?? "namespace-only";

    const runQuery = async () => {
      if (mode === "filtered-by-source") {
        if (!options?.sourceId) {
          throw new Error("sourceId is required for filtered-by-source mode");
        }

        return env.VECTORIZE.query(queryEmbedding, {
          namespace,
          topK,
          returnValues: false,
          returnMetadata: "indexed",
          filter: { sourceId: options.sourceId },
        });
      }

      const baseResults = await env.VECTORIZE.query(queryEmbedding, {
        namespace,
        topK,
        returnValues: false,
        returnMetadata: mode === "namespace-only" ? "indexed" : "all",
      });

      if (mode !== "broad-post-filter" || !options?.sourceId) {
        return baseResults;
      }

      return {
        ...baseResults,
        matches: (baseResults.matches || []).filter(
          (match) => match.metadata?.sourceId === options.sourceId,
        ),
      };
    };

    const results = await runQuery();

    console.log("[Vectorize Test Query]", {
      namespace,
      query: sampleQuery,
      mode,
      resultsCount: results.matches?.length || 0,
      hasMetadata: results.matches?.[0]?.metadata ? true : false,
      metadataKeys: results.matches?.[0]?.metadata
        ? Object.keys(results.matches[0].metadata)
        : [],
    });

    return {
      status: "success",
      mode,
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
    // Create a zero vector for listing (matches all with low scores)
    const zeroVector = new Array(EMBEDDING_CONFIG.DIMENSIONS).fill(0);

    const results = await env.VECTORIZE.query(zeroVector, {
      namespace,
      topK: limit,
      returnValues: false,
      returnMetadata: "indexed",
    });

    return {
      status: "success",
      count: results.matches?.length || 0,
      indexName: VECTORIZE_CONFIG.INDEX_NAME,
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

export async function inspectVectorizeExperienceFiltering(options: {
  namespace: string;
  query: string;
  sourceId?: string;
  topK?: number;
}) {
  const health = await checkVectorizeHealth(options.namespace);

  const namespaceOnly = await testVectorizeQuery(
    options.namespace,
    options.query,
    {
      mode: "namespace-only",
      topK: options.topK,
    },
  );

  const filtered = options.sourceId
    ? await testVectorizeQuery(options.namespace, options.query, {
        mode: "filtered-by-source",
        sourceId: options.sourceId,
        topK: options.topK,
      })
    : null;

  const broadPostFilter = options.sourceId
    ? await testVectorizeQuery(options.namespace, options.query, {
        mode: "broad-post-filter",
        sourceId: options.sourceId,
        topK: options.topK,
      })
    : null;

  return {
    indexName: VECTORIZE_CONFIG.INDEX_NAME,
    namespace: options.namespace,
    sourceId: options.sourceId ?? null,
    health,
    diagnostics: {
      namespaceOnly,
      filtered,
      broadPostFilter,
    },
  };
}

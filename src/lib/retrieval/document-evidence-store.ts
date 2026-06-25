import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { documentChunks, knowledgeSource } from "@/db/schema";
import { DEFAULT_MODELS, RAG_CONFIG } from "@/lib/ai/constants";
import {
  findRelevantContentWithEmbedding,
  generateEmbeddings,
  rerank,
  searchDocumentChunksFTS,
  type VectorSearchDiagnostics,
} from "@/lib/ai/embedding";
import { reciprocalRankFusion } from "@/lib/utils";
import type { DocumentEvidence, DocumentEvidenceDiagnostics } from "./types";

interface HybridSearchResult {
  id: string;
  score: number;
  vectorScore?: number;
  content: string;
  metadata: Record<string, unknown>;
}

interface MatchMetadata {
  sourceId?: string;
  chunkIndex?: number;
  documentId?: string;
  [key: string]: unknown;
}

export async function retrieveDocumentEvidence(options: {
  query: string;
  queries: string[];
  keywords: string[];
  agentId: string;
  topK: number;
  minSimilarity: number;
  knowledgeSourceIds?: string[];
  includeCatalogProductChunks?: boolean;
  rerank: boolean;
  rerankModel?: string;
}): Promise<{
  evidence: DocumentEvidence | null;
  diagnostics: DocumentEvidenceDiagnostics;
}> {
  const keywords =
    options.keywords.length > 0
      ? options.keywords
      : extractBasicKeywords(options.query);

  const hybridSearchStart = Date.now();
  const searchResult = await hybridSearch({
    queries: options.queries,
    keywords,
    agentId: options.agentId,
    topK: options.topK,
    minSimilarity: options.minSimilarity,
    knowledgeSourceIds: options.knowledgeSourceIds,
  });
  const hybridSearchMs = Date.now() - hybridSearchStart;

  let topMatches = searchResult.results.slice(0, 20);
  let enrichmentMs = 0;
  let rerankMs: number | undefined;

  if (topMatches.length > 0) {
    const enrichmentStart = Date.now();
    topMatches = await enrichWithFullText(topMatches, {
      includeCatalogProductChunks: options.includeCatalogProductChunks ?? true,
    });
    enrichmentMs += Date.now() - enrichmentStart;
  }

  if (options.rerank && topMatches.length > 0) {
    const rerankModelId = options.rerankModel || DEFAULT_MODELS.RERANKER;
    const rerankStart = Date.now();
    topMatches = await rerankResults({
      query: options.query,
      candidates: topMatches,
      topK: options.topK,
      rerankModelId,
    });
    rerankMs = Date.now() - rerankStart;
  } else if (topMatches.length > 0) {
    topMatches = topMatches.slice(0, options.topK);
  }

  if (topMatches.length > 0) {
    const neighborStart = Date.now();
    topMatches = await expandWithNeighborChunks(topMatches, options.topK, {
      includeCatalogProductChunks: options.includeCatalogProductChunks ?? true,
    });
    enrichmentMs += Date.now() - neighborStart;
  }

  const preFilterCount = topMatches.length;
  topMatches = topMatches.filter(
    (match) =>
      typeof match.content === "string" && match.content.trim().length > 0,
  );
  if (preFilterCount !== topMatches.length) {
    console.warn(
      `[DocumentEvidenceStore] Filtered out ${preFilterCount - topMatches.length} empty-content chunks`,
    );
  }

  const diagnostics: DocumentEvidenceDiagnostics = {
    keywords,
    vectorResultsCount: searchResult.vectorCount,
    ftsResultsCount: searchResult.ftsCount,
    vectorSearchMode: searchResult.vectorDiagnostics?.retrievalMode,
    vectorFilterCapability: searchResult.vectorDiagnostics?.filterCapability,
    vectorFilterApplied: searchResult.vectorDiagnostics?.filterApplied,
    vectorFilterReason: searchResult.vectorDiagnostics?.filterReason,
    vectorFallbackTopK: searchResult.vectorDiagnostics?.fallbackTopK,
    rerankEnabled: options.rerank,
    rerankModel: options.rerank
      ? options.rerankModel || DEFAULT_MODELS.RERANKER
      : undefined,
    timing: {
      vectorSearchMs: searchResult.timing.vectorSearchMs,
      ftsSearchMs: searchResult.timing.ftsSearchMs,
      hybridSearchMs,
      rerankMs,
      enrichmentMs,
    },
    chunks: topMatches.map((match) => {
      const metadata = match.metadata as MatchMetadata;
      return {
        id: match.id,
        content: String(match.content),
        score: match.score,
        vectorScore: match.vectorScore,
        rerankScore: options.rerank ? match.score : undefined,
        sourceId: metadata?.sourceId || match.id,
        metadata: match.metadata || {},
      };
    }),
  };

  if (topMatches.length === 0) {
    console.log("[DocumentEvidenceStore] No relevant chunks found");
    return { evidence: null, diagnostics };
  }

  const evidence: DocumentEvidence = {
    chunks: topMatches.map((match) => {
      const metadata = match.metadata as MatchMetadata;
      return {
        content: String(match.content),
        sourceId: metadata?.sourceId || match.id,
        score: match.score,
        metadata: match.metadata,
      };
    }),
  };

  console.log(
    `[DocumentEvidenceStore] Retrieved ${topMatches.length} document chunks`,
  );

  return { evidence, diagnostics };
}

async function hybridSearch(options: {
  queries: string[];
  keywords: string[];
  agentId: string;
  topK: number;
  minSimilarity: number;
  knowledgeSourceIds?: string[];
}): Promise<{
  results: HybridSearchResult[];
  vectorCount: number;
  ftsCount: number;
  vectorDiagnostics?: VectorSearchDiagnostics;
  timing: {
    vectorSearchMs: number;
    ftsSearchMs: number;
  };
}> {
  const cleanedQueries = options.queries
    .map((query) => query.trim())
    .filter(Boolean);
  if (cleanedQueries.length === 0) {
    return {
      results: [],
      vectorCount: 0,
      ftsCount: 0,
      timing: {
        vectorSearchMs: 0,
        ftsSearchMs: 0,
      },
    };
  }

  const topKPerQuery = Math.max(
    3,
    Math.ceil(options.topK / cleanedQueries.length),
  );

  const vectorSearchStart = Date.now();
  const queryEmbeddings = await generateEmbeddings(cleanedQueries);
  const vectorResults = await Promise.all(
    queryEmbeddings.map((embedding, index) =>
      findRelevantContentWithEmbedding(
        cleanedQueries[index],
        embedding,
        options.agentId,
        {
          topK: topKPerQuery,
          minSimilarity: options.minSimilarity / 100,
          knowledgeSourceIds: options.knowledgeSourceIds,
        },
      ),
    ),
  );
  const vectorSearchMs = Date.now() - vectorSearchStart;
  const vectorCount = vectorResults.reduce(
    (sum, result) => sum + result.matches.length,
    0,
  );
  const vectorDiagnostics = vectorResults[0]?.diagnostics;

  let ftsResults: Array<{ id: string; text: string; rank: number }> = [];
  let ftsSearchMs = 0;

  if (options.keywords.length > 0) {
    const ftsSearchStart = Date.now();
    try {
      ftsResults = await searchDocumentChunksFTS(
        options.keywords,
        options.agentId,
        {
          limit: topKPerQuery,
          knowledgeSourceIds: options.knowledgeSourceIds,
        },
      );
    } catch (_error) {
      console.warn(
        "[DocumentEvidenceStore] FTS unavailable; using vector only",
      );
    } finally {
      ftsSearchMs = Date.now() - ftsSearchStart;
    }
  }

  const ftsMatches = ftsResults.map((result) => ({
    id: result.id,
    content: result.text,
    score: result.rank,
    vectorScore: undefined,
    metadata: {},
  }));

  const allResultSets = [
    ...vectorResults.map((result) => result.matches),
    ftsMatches,
  ];
  const fusedResults = reciprocalRankFusion(
    allResultSets as Array<Array<{ id: string; score: number }>>,
    RAG_CONFIG.RRF_K,
  ) as HybridSearchResult[];

  return {
    results: fusedResults.slice(0, options.topK * 2),
    vectorCount,
    ftsCount: ftsResults.length,
    vectorDiagnostics,
    timing: {
      vectorSearchMs,
      ftsSearchMs,
    },
  };
}

async function rerankResults(options: {
  query: string;
  candidates: HybridSearchResult[];
  topK: number;
  rerankModelId: string;
}): Promise<HybridSearchResult[]> {
  if (options.candidates.length === 0) return [];

  const vectorScoreMap = new Map(
    options.candidates.map((candidate) => [
      candidate.id,
      candidate.vectorScore,
    ]),
  );

  const reranked = await rerank(
    options.query,
    options.candidates.map((candidate) => ({
      id: candidate.id,
      content: String(candidate.content),
      metadata: candidate.metadata,
    })),
    options.topK,
  );

  return reranked.map((result) => ({
    id: result.id,
    score: result.score,
    vectorScore: vectorScoreMap.get(result.id),
    content: result.content,
    metadata: result.metadata || {},
  }));
}

async function enrichWithFullText(
  matches: HybridSearchResult[],
  options: { includeCatalogProductChunks: boolean },
): Promise<HybridSearchResult[]> {
  try {
    const chunkIds = matches.map((match) => match.id);
    const catalogProductFilter = options.includeCatalogProductChunks
      ? undefined
      : isNull(documentChunks.productId);

    const dbRows = await db
      .select({
        id: documentChunks.id,
        text: documentChunks.text,
        documentId: documentChunks.documentId,
        chunkIndex: documentChunks.chunkIndex,
        fileName: knowledgeSource.fileName,
      })
      .from(documentChunks)
      .innerJoin(
        knowledgeSource,
        eq(documentChunks.documentId, knowledgeSource.id),
      )
      .where(
        and(
          inArray(documentChunks.id, chunkIds),
          eq(knowledgeSource.status, "indexed"),
          catalogProductFilter,
        ),
      );

    const dbRowMap = new Map(dbRows.map((row) => [row.id, row]));
    const enrichedMatches: HybridSearchResult[] = [];

    for (const match of matches) {
      const row = dbRowMap.get(match.id);
      if (!row) {
        console.warn(
          `[DocumentEvidenceStore] Chunk ${match.id} not found in indexed D1 sources`,
        );
        continue;
      }

      enrichedMatches.push({
        ...match,
        content: row.text,
        metadata: {
          ...match.metadata,
          contentLength: row.text.length,
          fileName: row.fileName || "Unknown source",
          sourceId: row.documentId,
          documentId: row.documentId,
          chunkIndex: row.chunkIndex,
        },
      });
    }

    return enrichedMatches;
  } catch (error) {
    console.warn(
      "[DocumentEvidenceStore] Failed to fetch authoritative document text from DB; dropping document candidates:",
      error,
    );
    return [];
  }
}

async function expandWithNeighborChunks(
  matches: HybridSearchResult[],
  topK: number,
  options: { includeCatalogProductChunks: boolean },
): Promise<HybridSearchResult[]> {
  const baseMatches = matches.filter(
    (match) =>
      match.metadata?.sourceId && match.metadata?.chunkIndex !== undefined,
  );
  if (baseMatches.length === 0) return matches;

  type NeighborKey = `${string}:${number}`;
  const baseByKey = new Map<NeighborKey, HybridSearchResult>();
  const neighborTargetSet = new Set<NeighborKey>();
  const neighborTargets: Array<{ documentId: string; chunkIndex: number }> = [];

  baseMatches.forEach((match) => {
    const metadata = match.metadata as MatchMetadata;
    const documentId = metadata.documentId || metadata.sourceId;
    const chunkIndex = metadata.chunkIndex;
    if (!documentId || chunkIndex === undefined || chunkIndex === null) return;

    baseByKey.set(`${documentId}:${chunkIndex}`, match);

    const prevKey: NeighborKey = `${documentId}:${chunkIndex - 1}`;
    const nextKey: NeighborKey = `${documentId}:${chunkIndex + 1}`;
    if (chunkIndex > 0 && !neighborTargetSet.has(prevKey)) {
      neighborTargetSet.add(prevKey);
      neighborTargets.push({ documentId, chunkIndex: chunkIndex - 1 });
    }
    if (!neighborTargetSet.has(nextKey)) {
      neighborTargetSet.add(nextKey);
      neighborTargets.push({ documentId, chunkIndex: chunkIndex + 1 });
    }
  });

  if (neighborTargets.length === 0) return matches;

  const byDocument = new Map<string, number[]>();
  for (const target of neighborTargets) {
    byDocument.set(target.documentId, [
      ...(byDocument.get(target.documentId) ?? []),
      target.chunkIndex,
    ]);
  }

  const docIds = [...byDocument.keys()];
  const allChunkIndices = [
    ...new Set(neighborTargets.map((target) => target.chunkIndex)),
  ];
  const catalogProductFilter = options.includeCatalogProductChunks
    ? undefined
    : isNull(documentChunks.productId);

  const candidateRows = await db
    .select({
      id: documentChunks.id,
      text: documentChunks.text,
      documentId: documentChunks.documentId,
      chunkIndex: documentChunks.chunkIndex,
    })
    .from(documentChunks)
    .innerJoin(
      knowledgeSource,
      eq(documentChunks.documentId, knowledgeSource.id),
    )
    .where(
      and(
        inArray(documentChunks.documentId, docIds),
        inArray(documentChunks.chunkIndex, allChunkIndices),
        eq(knowledgeSource.status, "indexed"),
        catalogProductFilter,
      ),
    );

  const existingIds = new Set(matches.map((match) => match.id));
  const neighborMatches: HybridSearchResult[] = candidateRows
    .filter((row) =>
      neighborTargetSet.has(`${row.documentId}:${row.chunkIndex}`),
    )
    .filter((row) => !existingIds.has(row.id))
    .map((row) => {
      const prevKey = `${row.documentId}:${row.chunkIndex + 1}` as NeighborKey;
      const nextKey = `${row.documentId}:${row.chunkIndex - 1}` as NeighborKey;
      const baseMatch = baseByKey.get(prevKey) || baseByKey.get(nextKey);
      const baseScore = baseMatch?.score ?? 0;

      return {
        id: row.id,
        content: row.text,
        score: baseScore * 0.9,
        vectorScore: baseMatch?.vectorScore,
        metadata: {
          ...baseMatch?.metadata,
          sourceId: row.documentId,
          documentId: row.documentId,
          chunkIndex: row.chunkIndex,
          contentLength: row.text.length,
          neighborOf: baseMatch?.id,
        },
      };
    });

  return [...matches, ...neighborMatches].slice(
    0,
    Math.max(topK * 2, topK + 2),
  );
}

function extractBasicKeywords(query: string, maxKeywords = 10): string[] {
  const normalizeKeyword = (token: string) =>
    token
      .normalize("NFD")
      .replace(/\p{M}+/gu, "")
      .replace(/ς/g, "σ")
      .toLowerCase();

  const tokens = query
    .split(/[\s,;:!?()[\]{}"«»\-–—]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const token of tokens) {
    const normalized = normalizeKeyword(token);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      unique.push(token);
    }
  }

  unique.sort((left, right) => right.length - left.length);
  return unique.slice(0, maxKeywords);
}

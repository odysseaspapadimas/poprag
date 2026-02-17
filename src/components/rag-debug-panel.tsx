import {
  BarChart3,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  Cpu,
  FileText,
  Search,
} from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

interface RAGDebugInfo {
  enabled: boolean;
  skippedByIntent?: boolean;
  intentReason?: string;
  originalQuery?: string;
  reformulatedQuery?: string; // CQR: standalone query after conversational reformulation
  cqrApplied?: boolean; // CQR: whether reformulation was applied
  rewrittenQueries?: string[];
  keywords?: string[];
  vectorResultsCount?: number;
  ftsResultsCount?: number;
  rerankEnabled?: boolean;
  rerankModel?: string;
  chunks?: Array<{
    id: string;
    content: string;
    score: number;
    vectorScore?: number; // Original vector similarity score (0-1)
    rerankScore?: number; // Reranker cross-encoder score
    sourceId?: string;
    metadata?: Record<string, unknown>;
  }>;
  // Timing metrics (in milliseconds)
  timing?: {
    conversationalReformulationMs?: number;
    intentClassificationMs?: number;
    queryRewriteMs?: number;
    vectorSearchMs?: number;
    ftsSearchMs?: number;
    hybridSearchMs?: number;
    rerankMs?: number;
    enrichmentMs?: number;
    totalRagMs?: number;
  };
  // Model information
  models?: {
    conversationalReformulationModel?: string;
    intentModel?: string;
    rewriteModel?: string;
    embeddingModel?: string;
    embeddingDimensions?: number;
    rerankModel?: string;
    chatModel?: string;
    chatProvider?: string;
  };
}

interface RAGDebugPanelProps {
  debugInfo: RAGDebugInfo | null;
}

// Helper to format model names for display
const formatModelName = (model: string) => {
  // Shorten long model names by extracting the key part
  if (model.startsWith("@cf/")) {
    return model.replace("@cf/", "");
  }
  return model;
};

export function RAGDebugPanel({ debugInfo }: RAGDebugPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [expandedChunks, setExpandedChunks] = useState<Set<number>>(new Set());

  if (!debugInfo || !debugInfo.enabled) {
    return null;
  }

  // Show skipped message if intent classification skipped RAG
  if (debugInfo.skippedByIntent) {
    return (
      <Collapsible open={isOpen} onOpenChange={setIsOpen} className="w-full">
        <CollapsibleTrigger asChild>
          <Button
            variant="outline"
            className="w-full justify-between text-sm"
            size="sm"
          >
            <div className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4" />
              <span>RAG Debug Info</span>
              <Badge
                variant="secondary"
                className="ml-2 bg-yellow-500/20 text-yellow-700 dark:text-yellow-400"
              >
                Skipped
              </Badge>
            </div>
            {isOpen ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2">
          <div className="bg-muted/50 border rounded-lg p-4 space-y-2 text-sm">
            <div className="flex items-center gap-2 font-semibold">
              <Search className="h-4 w-4" />
              <span>RAG Skipped by Intent Classification</span>
            </div>
            {debugInfo.originalQuery && (
              <div className="pl-6">
                <span className="text-muted-foreground">Query: </span>
                <span className="font-mono text-xs">
                  {debugInfo.originalQuery}
                </span>
              </div>
            )}
            <div className="pl-6">
              <span className="text-muted-foreground">Reason: </span>
              <span>{debugInfo.intentReason}</span>
            </div>
            {/* Show timing and models even for skipped queries */}
            {(debugInfo.timing?.intentClassificationMs ||
              debugInfo.models?.intentModel ||
              debugInfo.models?.chatModel) && (
              <div className="pl-6 pt-2 border-t mt-2 space-y-1">
                {debugInfo.models?.intentModel && (
                  <div className="flex items-center gap-2 text-xs">
                    <Cpu className="h-3 w-3 text-muted-foreground" />
                    <span className="text-muted-foreground">Intent Model:</span>
                    <span className="font-mono">
                      {formatModelName(debugInfo.models.intentModel)}
                    </span>
                  </div>
                )}
                {debugInfo.models?.chatModel && (
                  <div className="flex items-center gap-2 text-xs">
                    <Cpu className="h-3 w-3 text-muted-foreground" />
                    <span className="text-muted-foreground">Chat Model:</span>
                    <span className="font-mono">
                      {debugInfo.models.chatModel}
                    </span>
                    {debugInfo.models.chatProvider && (
                      <Badge
                        variant="outline"
                        className="text-[10px] px-1 py-0"
                      >
                        {debugInfo.models.chatProvider}
                      </Badge>
                    )}
                  </div>
                )}
                {debugInfo.timing?.intentClassificationMs && (
                  <div className="flex items-center gap-2 text-xs">
                    <Clock className="h-3 w-3 text-muted-foreground" />
                    <span className="text-muted-foreground">
                      Intent Classification:
                    </span>
                    <span className="font-mono">
                      {debugInfo.timing.intentClassificationMs}ms
                    </span>
                  </div>
                )}
              </div>
            )}
            <div className="pl-6 text-xs text-muted-foreground">
              The query was classified as not requiring knowledge base retrieval
              (e.g., greeting, acknowledgment, small talk).
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  }

  const toggleChunk = (index: number) => {
    const newExpanded = new Set(expandedChunks);
    if (newExpanded.has(index)) {
      newExpanded.delete(index);
    } else {
      newExpanded.add(index);
    }
    setExpandedChunks(newExpanded);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const formatScore = (score: number) => {
    return score.toFixed(4);
  };

  const getVectorScoreColor = (score: number) => {
    // Vector similarity scores range from 0-1 (cosine similarity)
    // OpenAI text-embedding-3-small produces lower scores than BGE models
    // Typical relevant results: 0.15-0.40
    if (score >= 0.35)
      return "bg-green-500/20 text-green-700 dark:text-green-400";
    if (score >= 0.25)
      return "bg-yellow-500/20 text-yellow-700 dark:text-yellow-400";
    if (score >= 0.15)
      return "bg-orange-500/20 text-orange-700 dark:text-orange-400";
    return "bg-red-500/20 text-red-700 dark:text-red-400";
  };

  const getRerankScoreColor = (score: number) => {
    // Reranker scores are typically much lower (different scale)
    // Positive scores indicate relevance, higher is better
    if (score >= 0.08)
      return "bg-green-500/20 text-green-700 dark:text-green-400";
    if (score >= 0.05)
      return "bg-yellow-500/20 text-yellow-700 dark:text-yellow-400";
    if (score >= 0.02)
      return "bg-orange-500/20 text-orange-700 dark:text-orange-400";
    return "bg-blue-500/20 text-blue-700 dark:text-blue-400";
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="w-full">
      <CollapsibleTrigger asChild>
        <Button
          variant="outline"
          className="w-full justify-between text-sm"
          size="sm"
        >
          <div className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4" />
            <span>RAG Debug Info</span>
            {debugInfo.chunks && debugInfo.chunks.length > 0 && (
              <Badge variant="secondary" className="ml-2">
                {debugInfo.chunks.length} chunks
              </Badge>
            )}
            {debugInfo.timing?.totalRagMs && (
              <Badge variant="outline" className="ml-1 text-xs">
                {debugInfo.timing.totalRagMs}ms
              </Badge>
            )}
            {debugInfo.models?.chatModel && (
              <Badge
                variant="outline"
                className="ml-1 text-xs hidden sm:inline-flex"
              >
                {debugInfo.models.chatModel}
              </Badge>
            )}
          </div>
          {isOpen ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2">
        <div className="bg-muted/50 border rounded-lg p-4 space-y-4 text-sm">
          {/* Query Information */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 font-semibold">
              <Search className="h-4 w-4" />
              <span>Query Information</span>
            </div>
            {debugInfo.originalQuery && (
              <div className="pl-6 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Original Query:</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2"
                    onClick={() => copyToClipboard(debugInfo.originalQuery!)}
                  >
                    <Copy className="h-3 w-3" />
                  </Button>
                </div>
                <div className="bg-background border rounded p-2 font-mono text-xs break-words">
                  {debugInfo.originalQuery}
                </div>
              </div>
            )}
            {debugInfo.cqrApplied && debugInfo.reformulatedQuery && (
              <div className="pl-6 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">
                    Reformulated Query (CQR):
                  </span>
                  <Badge
                    variant="secondary"
                    className="bg-blue-500/20 text-blue-700 dark:text-blue-400 text-[10px]"
                  >
                    Multi-turn
                  </Badge>
                </div>
                <div className="bg-blue-500/10 border border-blue-500/20 rounded p-2 font-mono text-xs break-words">
                  {debugInfo.reformulatedQuery}
                </div>
              </div>
            )}
            {debugInfo.rewrittenQueries &&
              debugInfo.rewrittenQueries.length > 0 && (
                <div className="pl-6 space-y-1">
                  <div className="text-muted-foreground">
                    Rewritten Queries:
                  </div>
                  <div className="space-y-1">
                    {debugInfo.rewrittenQueries.map((query) => (
                      <div
                        key={query}
                        className="bg-background border rounded p-2 font-mono text-xs break-words"
                      >
                        {query}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            {debugInfo.keywords && debugInfo.keywords.length > 0 && (
              <div className="pl-6 space-y-1">
                <div className="text-muted-foreground">Extracted Keywords:</div>
                <div className="flex flex-wrap gap-1">
                  {debugInfo.keywords.map((keyword) => (
                    <Badge key={keyword} variant="outline" className="text-xs">
                      {keyword}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Search Results Summary */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 font-semibold">
              <BarChart3 className="h-4 w-4" />
              <span>Search Results</span>
            </div>
            <div className="pl-6 grid grid-cols-2 gap-2">
              <div className="bg-background border rounded p-2">
                <div className="text-xs text-muted-foreground">
                  Vector Results
                </div>
                <div className="text-lg font-semibold">
                  {debugInfo.vectorResultsCount ?? 0}
                </div>
              </div>
              <div className="bg-background border rounded p-2">
                <div className="text-xs text-muted-foreground">FTS Results</div>
                <div className="text-lg font-semibold">
                  {debugInfo.ftsResultsCount ?? 0}
                </div>
              </div>
            </div>
            {debugInfo.rerankEnabled && (
              <div className="pl-6">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">Reranking Enabled</Badge>
                  {debugInfo.rerankModel && (
                    <span className="text-xs text-muted-foreground">
                      Model: {debugInfo.rerankModel}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Models Used */}
          {debugInfo.models && Object.keys(debugInfo.models).length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 font-semibold">
                <Cpu className="h-4 w-4" />
                <span>Models Used</span>
              </div>
              <div className="pl-6 grid grid-cols-1 sm:grid-cols-2 gap-2">
                {debugInfo.models.conversationalReformulationModel && (
                  <div className="bg-background border rounded p-2">
                    <div className="text-xs text-muted-foreground">
                      CQR (Reformulation)
                    </div>
                    <div
                      className="text-sm font-mono truncate"
                      title={debugInfo.models.conversationalReformulationModel}
                    >
                      {formatModelName(
                        debugInfo.models.conversationalReformulationModel,
                      )}
                    </div>
                  </div>
                )}
                {debugInfo.models.chatModel && (
                  <div className="bg-background border rounded p-2">
                    <div className="text-xs text-muted-foreground">
                      Chat Model
                    </div>
                    <div
                      className="text-sm font-mono truncate"
                      title={debugInfo.models.chatModel}
                    >
                      {debugInfo.models.chatModel}
                    </div>
                    {debugInfo.models.chatProvider && (
                      <Badge variant="outline" className="text-[10px] mt-1">
                        {debugInfo.models.chatProvider}
                      </Badge>
                    )}
                  </div>
                )}
                {debugInfo.models.intentModel && (
                  <div className="bg-background border rounded p-2">
                    <div className="text-xs text-muted-foreground">
                      Intent Classification
                    </div>
                    <div
                      className="text-sm font-mono truncate"
                      title={debugInfo.models.intentModel}
                    >
                      {formatModelName(debugInfo.models.intentModel)}
                    </div>
                  </div>
                )}
                {debugInfo.models.rewriteModel && (
                  <div className="bg-background border rounded p-2">
                    <div className="text-xs text-muted-foreground">
                      Query Rewrite
                    </div>
                    <div
                      className="text-sm font-mono truncate"
                      title={debugInfo.models.rewriteModel}
                    >
                      {formatModelName(debugInfo.models.rewriteModel)}
                    </div>
                  </div>
                )}
                {debugInfo.models.embeddingModel && (
                  <div className="bg-background border rounded p-2">
                    <div className="text-xs text-muted-foreground">
                      Embedding
                    </div>
                    <div
                      className="text-sm font-mono truncate"
                      title={debugInfo.models.embeddingModel}
                    >
                      {formatModelName(debugInfo.models.embeddingModel)}
                    </div>
                    {debugInfo.models.embeddingDimensions && (
                      <div className="text-[10px] text-muted-foreground mt-1">
                        {debugInfo.models.embeddingDimensions} dims
                      </div>
                    )}
                  </div>
                )}
                {debugInfo.models.rerankModel && (
                  <div className="bg-background border rounded p-2">
                    <div className="text-xs text-muted-foreground">
                      Reranker
                    </div>
                    <div
                      className="text-sm font-mono truncate"
                      title={debugInfo.models.rerankModel}
                    >
                      {formatModelName(debugInfo.models.rerankModel)}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Timing Information */}
          {debugInfo.timing && Object.keys(debugInfo.timing).length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 font-semibold">
                <Clock className="h-4 w-4" />
                <span>Performance Timing</span>
                {debugInfo.timing.totalRagMs && (
                  <Badge variant="secondary" className="ml-auto">
                    Total: {debugInfo.timing.totalRagMs}ms
                  </Badge>
                )}
              </div>
              <div className="pl-6">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {debugInfo.timing.conversationalReformulationMs !==
                    undefined && (
                    <div className="bg-background border rounded p-2">
                      <div className="text-xs text-muted-foreground">CQR</div>
                      <div className="text-lg font-semibold">
                        {debugInfo.timing.conversationalReformulationMs}
                        <span className="text-xs font-normal text-muted-foreground">
                          ms
                        </span>
                      </div>
                    </div>
                  )}
                  {debugInfo.timing.intentClassificationMs !== undefined && (
                    <div className="bg-background border rounded p-2">
                      <div className="text-xs text-muted-foreground">
                        Intent
                      </div>
                      <div className="text-lg font-semibold">
                        {debugInfo.timing.intentClassificationMs}
                        <span className="text-xs font-normal text-muted-foreground">
                          ms
                        </span>
                      </div>
                    </div>
                  )}
                  {debugInfo.timing.queryRewriteMs !== undefined && (
                    <div className="bg-background border rounded p-2">
                      <div className="text-xs text-muted-foreground">
                        Query Rewrite
                      </div>
                      <div className="text-lg font-semibold">
                        {debugInfo.timing.queryRewriteMs}
                        <span className="text-xs font-normal text-muted-foreground">
                          ms
                        </span>
                      </div>
                    </div>
                  )}
                  {debugInfo.timing.vectorSearchMs !== undefined && (
                    <div className="bg-background border rounded p-2">
                      <div className="text-xs text-muted-foreground">
                        Vector Search
                      </div>
                      <div className="text-lg font-semibold">
                        {debugInfo.timing.vectorSearchMs}
                        <span className="text-xs font-normal text-muted-foreground">
                          ms
                        </span>
                      </div>
                    </div>
                  )}
                  {debugInfo.timing.ftsSearchMs !== undefined &&
                    debugInfo.timing.ftsSearchMs > 0 && (
                      <div className="bg-background border rounded p-2">
                        <div className="text-xs text-muted-foreground">
                          FTS Search
                        </div>
                        <div className="text-lg font-semibold">
                          {debugInfo.timing.ftsSearchMs}
                          <span className="text-xs font-normal text-muted-foreground">
                            ms
                          </span>
                        </div>
                      </div>
                    )}
                  {debugInfo.timing.rerankMs !== undefined && (
                    <div className="bg-background border rounded p-2">
                      <div className="text-xs text-muted-foreground">
                        Rerank
                      </div>
                      <div className="text-lg font-semibold">
                        {debugInfo.timing.rerankMs}
                        <span className="text-xs font-normal text-muted-foreground">
                          ms
                        </span>
                      </div>
                    </div>
                  )}
                  {debugInfo.timing.enrichmentMs !== undefined && (
                    <div className="bg-background border rounded p-2">
                      <div className="text-xs text-muted-foreground">
                        DB Enrichment
                      </div>
                      <div className="text-lg font-semibold">
                        {debugInfo.timing.enrichmentMs}
                        <span className="text-xs font-normal text-muted-foreground">
                          ms
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Retrieved Chunks */}
          {debugInfo.chunks && debugInfo.chunks.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 font-semibold">
                <FileText className="h-4 w-4" />
                <span>Retrieved Chunks ({debugInfo.chunks.length})</span>
              </div>
              <div className="pl-6 space-y-2">
                {debugInfo.chunks.map((chunk, idx) => {
                  const isExpanded = expandedChunks.has(idx);
                  const fileName =
                    (chunk.metadata?.fileName as string) ||
                    chunk.sourceId?.slice(0, 8) ||
                    "Unknown";

                  return (
                    <div
                      key={chunk.id}
                      className="bg-background border rounded-lg overflow-hidden"
                    >
                      <div className="p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2 flex-wrap">
                            {chunk.rerankScore !== undefined ? (
                              <>
                                <Badge
                                  className={getRerankScoreColor(
                                    chunk.rerankScore,
                                  )}
                                >
                                  Rerank: {formatScore(chunk.rerankScore)}
                                </Badge>
                                {chunk.vectorScore !== undefined && (
                                  <Badge
                                    className={getVectorScoreColor(
                                      chunk.vectorScore,
                                    )}
                                  >
                                    Vector: {formatScore(chunk.vectorScore)}
                                  </Badge>
                                )}
                              </>
                            ) : (
                              <Badge
                                className={
                                  chunk.vectorScore !== undefined
                                    ? getVectorScoreColor(chunk.vectorScore)
                                    : getVectorScoreColor(chunk.score)
                                }
                              >
                                {chunk.vectorScore !== undefined
                                  ? "Vector"
                                  : "Score"}
                                : {formatScore(chunk.score)}
                              </Badge>
                            )}
                            <span className="text-xs text-muted-foreground">
                              #{idx + 1}
                            </span>
                            {chunk.sourceId && (
                              <span className="text-xs text-muted-foreground font-mono">
                                Source: {chunk.sourceId.slice(0, 8)}...
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1">
                            <span className="text-xs text-muted-foreground">
                              {fileName}
                            </span>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2"
                              onClick={() => toggleChunk(idx)}
                            >
                              {isExpanded ? (
                                <ChevronUp className="h-3 w-3" />
                              ) : (
                                <ChevronDown className="h-3 w-3" />
                              )}
                            </Button>
                          </div>
                        </div>
                        {isExpanded && (
                          <div className="space-y-2 pt-2 border-t">
                            <div className="text-xs text-muted-foreground">
                              Content:
                            </div>
                            <div className="bg-muted rounded p-2 font-mono text-xs max-h-48 overflow-y-auto break-words">
                              {chunk.content}
                            </div>
                            {Object.keys(chunk.metadata || {}).length > 0 && (
                              <details className="text-xs">
                                <summary className="cursor-pointer text-muted-foreground">
                                  Metadata
                                </summary>
                                <pre className="mt-2 bg-muted rounded p-2 overflow-x-auto">
                                  {JSON.stringify(chunk.metadata, null, 2)}
                                </pre>
                              </details>
                            )}
                          </div>
                        )}
                        {!isExpanded && (
                          <div className="text-xs text-muted-foreground line-clamp-2">
                            {chunk.content}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {(!debugInfo.chunks || debugInfo.chunks.length === 0) && (
            <div className="text-center text-sm text-muted-foreground py-4">
              No chunks retrieved for this query
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

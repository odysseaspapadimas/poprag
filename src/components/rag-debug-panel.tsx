import {
  BarChart3,
  ChevronDown,
  ChevronUp,
  Copy,
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
  originalQuery?: string;
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
    sourceId?: string;
    metadata?: Record<string, unknown>;
  }>;
}

interface RAGDebugPanelProps {
  debugInfo: RAGDebugInfo | null;
}

export function RAGDebugPanel({ debugInfo }: RAGDebugPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [expandedChunks, setExpandedChunks] = useState<Set<number>>(new Set());

  if (!debugInfo || !debugInfo.enabled) {
    return null;
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

  const getScoreColor = (score: number) => {
    if (score >= 0.7)
      return "bg-green-500/20 text-green-700 dark:text-green-400";
    if (score >= 0.5)
      return "bg-yellow-500/20 text-yellow-700 dark:text-yellow-400";
    return "bg-red-500/20 text-red-700 dark:text-red-400";
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
            {debugInfo.rewrittenQueries &&
              debugInfo.rewrittenQueries.length > 0 && (
                <div className="pl-6 space-y-1">
                  <div className="text-muted-foreground">
                    Rewritten Queries:
                  </div>
                  <div className="space-y-1">
                    {debugInfo.rewrittenQueries.map((query, idx) => (
                      <div
                        key={idx}
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
                  {debugInfo.keywords.map((keyword, idx) => (
                    <Badge key={idx} variant="outline" className="text-xs">
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
                  const scoreColor = getScoreColor(chunk.score);
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
                          <div className="flex items-center gap-2">
                            <Badge className={scoreColor}>
                              Score: {formatScore(chunk.score)}
                            </Badge>
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

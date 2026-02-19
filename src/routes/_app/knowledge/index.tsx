import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Database,
  FileText,
  HardDrive,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { KnowledgeSourceViewer } from "@/components/knowledge-source-viewer";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTRPC } from "@/integrations/trpc/react";
import { formatNumber } from "@/lib/utils";

export const Route = createFileRoute("/_app/knowledge/")({
  component: KnowledgeHealthPage,
  beforeLoad: async ({ context }) => {
    await context.queryClient.prefetchQuery(
      context.trpc.knowledge.healthOverview.queryOptions({}),
    );
  },
});

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number.parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
}

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, { color: string; icon: React.ReactNode }> = {
    indexed: {
      color:
        "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
      icon: <CheckCircle2 className="h-3 w-3" />,
    },
    parsed: {
      color: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
      icon: <FileText className="h-3 w-3" />,
    },
    uploaded: {
      color:
        "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
      icon: <Clock className="h-3 w-3" />,
    },
    processing: {
      color:
        "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
      icon: <Loader2 className="h-3 w-3 animate-spin" />,
    },
    failed: {
      color: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
      icon: <AlertCircle className="h-3 w-3" />,
    },
  };

  const variant = variants[status] || variants.uploaded;

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium ${variant.color}`}
    >
      {variant.icon}
      {status}
    </span>
  );
}

function KnowledgeHealthPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [selectedSources, setSelectedSources] = useState<Set<string>>(
    new Set(),
  );
  const [viewingSource, setViewingSource] = useState<{
    id: string;
    fileName: string;
    mime: string | null;
  } | null>(null);
  const [detailSourceId, setDetailSourceId] = useState<string | null>(null);

  const { data: healthData } = useSuspenseQuery(
    trpc.knowledge.healthOverview.queryOptions({}),
  );

  const { data: detailData, isLoading: isLoadingDetail } = useQuery(
    trpc.knowledge.healthDetail.queryOptions(
      { sourceId: detailSourceId! },
      { enabled: !!detailSourceId },
    ),
  );

  const bulkReindexMutation = useMutation(
    trpc.knowledge.bulkReindex.mutationOptions({
      onSuccess: (result) => {
        toast.success(`Reindexed ${result.successful}/${result.total} sources`);
        if (result.failed > 0) {
          toast.error(`${result.failed} sources failed to reindex`);
        }
        queryClient.invalidateQueries({
          queryKey: trpc.knowledge.healthOverview.queryKey({}),
        });
        setSelectedSources(new Set());
      },
      onError: (error) => {
        toast.error(`Bulk reindex failed: ${error.message}`);
      },
    }),
  );

  const toggleSource = (sourceId: string) => {
    const newSelected = new Set(selectedSources);
    if (newSelected.has(sourceId)) {
      newSelected.delete(sourceId);
    } else {
      newSelected.add(sourceId);
    }
    setSelectedSources(newSelected);
  };

  const selectAllFailed = () => {
    const failedIds = healthData.agents
      .flatMap((a) => a.sources)
      .filter((s) => s.status === "failed")
      .map((s) => s.id);
    setSelectedSources(new Set(failedIds));
  };

  const selectAllStale = () => {
    const staleIds = healthData.agents
      .flatMap((a) => a.sources)
      .filter((s) => s.isStale)
      .map((s) => s.id);
    setSelectedSources(new Set(staleIds));
  };

  const handleBulkReindex = () => {
    if (selectedSources.size === 0) {
      toast.error("No sources selected");
      return;
    }
    bulkReindexMutation.mutate({ sourceIds: Array.from(selectedSources) });
  };

  // Calculate health score
  const healthScore =
    healthData.totalSources > 0
      ? Math.round(
          (healthData.statusCounts.indexed / healthData.totalSources) * 70 +
            ((healthData.totalSources - healthData.staleCount) /
              healthData.totalSources) *
              30,
        )
      : 100;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold">Knowledge</h1>
        <p className="text-muted-foreground mt-1">
          Monitor ingestion status, staleness, and issues across all knowledge
          sources
        </p>
      </div>

      {/* Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Health Score
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-4">
              <div className="text-3xl font-bold">{healthScore}%</div>
              <Progress value={healthScore} className="flex-1" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Sources
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Database className="h-5 w-5 text-muted-foreground" />
              <span className="text-3xl font-bold">
                {healthData.totalSources}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {formatNumber(healthData.totalChunks)} chunks total
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Storage Used
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <HardDrive className="h-5 w-5 text-muted-foreground" />
              <span className="text-3xl font-bold">
                {formatBytes(healthData.totalBytes)}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Status Breakdown
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2 flex-wrap">
              <Badge
                variant="outline"
                className="bg-green-50 dark:bg-green-950"
              >
                {healthData.statusCounts.indexed} indexed
              </Badge>
              {healthData.statusCounts.processing > 0 && (
                <Badge
                  variant="outline"
                  className="bg-purple-50 dark:bg-purple-950"
                >
                  {healthData.statusCounts.processing} processing
                </Badge>
              )}
              <Badge
                variant="outline"
                className="bg-yellow-50 dark:bg-yellow-950"
              >
                {healthData.statusCounts.uploaded} pending
              </Badge>
              <Badge variant="outline" className="bg-red-50 dark:bg-red-950">
                {healthData.statusCounts.failed} failed
              </Badge>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Alerts Section */}
      {(healthData.statusCounts.failed > 0 || healthData.staleCount > 0) && (
        <div className="space-y-3">
          {healthData.statusCounts.failed > 0 && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Failed Indexing</AlertTitle>
              <AlertDescription className="flex items-center justify-between">
                <span>
                  {healthData.statusCounts.failed} knowledge source(s) failed to
                  index.
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={selectAllFailed}
                  className="ml-4"
                >
                  Select Failed
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {healthData.staleCount > 0 && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Stale Content</AlertTitle>
              <AlertDescription className="flex items-center justify-between">
                <span>
                  {healthData.staleCount} knowledge source(s) haven't been
                  updated in over 30 days.
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={selectAllStale}
                  className="ml-4"
                >
                  Select Stale
                </Button>
              </AlertDescription>
            </Alert>
          )}
        </div>
      )}

      {/* Bulk Actions */}
      {selectedSources.size > 0 && (
        <div className="flex items-center gap-4 p-4 bg-muted rounded-lg">
          <span className="text-sm font-medium">
            {selectedSources.size} source(s) selected
          </span>
          <Button
            onClick={handleBulkReindex}
            disabled={bulkReindexMutation.isPending}
            size="sm"
          >
            <RefreshCw
              className={`h-4 w-4 mr-2 ${bulkReindexMutation.isPending ? "animate-spin" : ""}`}
            />
            Re-index Selected
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelectedSources(new Set())}
          >
            Clear Selection
          </Button>
        </div>
      )}

      {/* Sources by Agent */}
      {healthData.agents.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Database className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium">No Knowledge Sources</h3>
            <p className="text-muted-foreground mt-2">
              Upload knowledge sources to your agents to see health status here.
            </p>
            <Link to="/agents">
              <Button variant="outline" className="mt-4">
                Go to Agents
              </Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {healthData.agents.map((agentData) => (
            <Card key={agentData.id}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle>
                      <Link
                        to="/agents/$agentId"
                        params={{ agentId: agentData.id }}
                        search={{ tab: "knowledge" }}
                        className="hover:underline"
                      >
                        {agentData.name}
                      </Link>
                    </CardTitle>
                    <CardDescription>/{agentData.slug}</CardDescription>
                  </div>
                  <Badge variant="outline">
                    {agentData.sources.length} sources
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">
                        <Checkbox
                          checked={agentData.sources.every((s) =>
                            selectedSources.has(s.id),
                          )}
                          onCheckedChange={(
                            checked: boolean | "indeterminate",
                          ) => {
                            const newSelected = new Set(selectedSources);
                            if (checked === true) {
                              for (const s of agentData.sources) {
                                newSelected.add(s.id);
                              }
                            } else {
                              for (const s of agentData.sources) {
                                newSelected.delete(s.id);
                              }
                            }
                            setSelectedSources(newSelected);
                          }}
                        />
                      </TableHead>
                      <TableHead>File Name</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Chunks</TableHead>
                      <TableHead>Size</TableHead>
                      <TableHead>Age</TableHead>
                      <TableHead>Issues</TableHead>
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {agentData.sources.map((source) => (
                      <TableRow
                        key={source.id}
                        className={
                          source.hasErrors || source.isStale
                            ? "bg-red-50/50 dark:bg-red-950/20"
                            : ""
                        }
                      >
                        <TableCell>
                          <Checkbox
                            checked={selectedSources.has(source.id)}
                            onCheckedChange={() => toggleSource(source.id)}
                          />
                        </TableCell>
                        <TableCell>
                          <button
                            type="button"
                            onClick={() =>
                              setViewingSource({
                                id: source.id,
                                fileName: source.fileName || "Unknown",
                                mime: source.mime,
                              })
                            }
                            className="font-medium hover:text-primary transition-colors text-left"
                          >
                            {source.fileName || "Untitled"}
                          </button>
                          <p className="text-xs text-muted-foreground">
                            {source.mime}
                          </p>
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={source.status} />
                        </TableCell>
                        <TableCell>{source.chunkCount}</TableCell>
                        <TableCell>{formatBytes(source.bytes || 0)}</TableCell>
                        <TableCell>
                          <span
                            className={
                              source.isStale
                                ? "text-amber-600 dark:text-amber-400"
                                : ""
                            }
                          >
                            {source.daysSinceUpdate}d ago
                          </span>
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            {source.status === "failed" && (
                              <Badge variant="destructive" className="text-xs">
                                Failed
                              </Badge>
                            )}
                            {source.isStale && (
                              <Badge
                                variant="outline"
                                className="text-xs text-amber-600"
                              >
                                Stale
                              </Badge>
                            )}
                            {source.hasErrors && (
                              <Badge variant="destructive" className="text-xs">
                                Errors
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setDetailSourceId(source.id)}
                          >
                            Details
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Detail Dialog */}
      <Dialog
        open={!!detailSourceId}
        onOpenChange={(open) => !open && setDetailSourceId(null)}
      >
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Source Health Details</DialogTitle>
            <DialogDescription>
              Detailed health information for this knowledge source
            </DialogDescription>
          </DialogHeader>
          {isLoadingDetail ? (
            <div className="py-8 text-center text-muted-foreground">
              Loading...
            </div>
          ) : detailData ? (
            <div className="space-y-6">
              {/* Source Info */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">
                    File Name
                  </p>
                  <p className="font-medium">{detailData.source.fileName}</p>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">
                    Status
                  </p>
                  <StatusBadge status={detailData.source.status} />
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">
                    Chunks
                  </p>
                  <p>{detailData.chunkCount}</p>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">
                    Vector Coverage
                  </p>
                  <div className="flex items-center gap-2">
                    <Progress
                      value={detailData.vectorCoverage}
                      className="w-20"
                    />
                    <span>{Math.round(detailData.vectorCoverage)}%</span>
                  </div>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">
                    R2 File
                  </p>
                  <Badge
                    variant={detailData.r2Exists ? "outline" : "destructive"}
                  >
                    {detailData.r2Exists ? "Exists" : "Missing"}
                  </Badge>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">
                    Last Updated
                  </p>
                  <p>
                    {detailData.daysSinceUpdate} days ago
                    {detailData.isStale && (
                      <Badge variant="outline" className="ml-2 text-amber-600">
                        Stale
                      </Badge>
                    )}
                  </p>
                </div>
              </div>

              {/* Issues */}
              {detailData.issues.length > 0 && (
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-2">
                    Issues
                  </p>
                  <div className="space-y-2">
                    {detailData.issues.map((issue) => (
                      <Alert
                        key={`${issue.type}-${issue.message}`}
                        variant={
                          issue.type === "error" ? "destructive" : "default"
                        }
                      >
                        {issue.type === "error" ? (
                          <AlertCircle className="h-4 w-4" />
                        ) : (
                          <AlertTriangle className="h-4 w-4" />
                        )}
                        <AlertDescription>{issue.message}</AlertDescription>
                      </Alert>
                    ))}
                  </div>
                </div>
              )}

              {/* Sample Chunks */}
              {detailData.sampleChunks.length > 0 && (
                <div>
                  <p className="text-sm font-medium text-muted-foreground mb-2">
                    Sample Chunks ({detailData.sampleChunks.length} of{" "}
                    {detailData.chunkCount})
                  </p>
                  <div className="space-y-2 max-h-60 overflow-y-auto">
                    {detailData.sampleChunks.map((chunk) => (
                      <div
                        key={chunk.id}
                        className="p-3 bg-muted rounded text-sm"
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs text-muted-foreground">
                            Chunk #{chunk.chunkIndex}
                          </span>
                          {chunk.vectorizeId ? (
                            <Badge variant="outline" className="text-xs">
                              Vectorized
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className="text-xs text-muted-foreground"
                            >
                              Legacy (pre-fix)
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs line-clamp-3">{chunk.text}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Knowledge Source Viewer Modal */}
      {viewingSource && (
        <KnowledgeSourceViewer
          sourceId={viewingSource.id}
          fileName={viewingSource.fileName}
          mime={viewingSource.mime}
          open={!!viewingSource}
          onOpenChange={(open) => {
            if (!open) {
              setViewingSource(null);
            }
          }}
        />
      )}
    </div>
  );
}

export default KnowledgeHealthPage;

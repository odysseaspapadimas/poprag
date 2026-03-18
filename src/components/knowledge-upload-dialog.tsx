import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Loader2, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { FileUpload } from "@/components/ui/file-upload";
import { Progress } from "@/components/ui/progress";
import { useTRPC } from "@/integrations/trpc/react";
import { MAX_KNOWLEDGE_FILE_SIZE } from "@/lib/ai/constants";
import { cn } from "@/lib/utils";

interface KnowledgeUploadDialogProps {
  agentId: string;
  trigger: React.ReactNode;
}

interface UploadProgressState {
  sourceId?: string;
  fileName: string;
  stage: string;
  progress: number;
  status?: string;
  retryCount?: number;
  parserErrors?: string[];
  chunksProcessed?: number;
  vectorsInserted?: number;
}

function getStatusTone(status?: string): string {
  switch (status) {
    case "indexed":
      return "text-emerald-700 dark:text-emerald-300";
    case "failed":
      return "text-red-700 dark:text-red-300";
    case "processing":
      return "text-amber-700 dark:text-amber-300";
    default:
      return "text-muted-foreground";
  }
}

function assertUploadStartResult<T>(
  value: T | null | undefined,
): asserts value is T {
  if (!value) {
    throw new Error("Failed to initiate upload");
  }
}

async function assertSuccessfulUploadResponse(
  response: Response,
): Promise<void> {
  if (response.ok) {
    return;
  }

  const errorText = await response.text();
  throw new Error(
    `Upload failed: ${response.statusText}${errorText ? ` - ${errorText}` : ""}`,
  );
}

export function KnowledgeUploadDialog({
  agentId,
  trigger,
}: KnowledgeUploadDialogProps) {
  const [open, setOpen] = useState(false);
  const [uploadProgress, setUploadProgress] =
    useState<UploadProgressState | null>(null);
  const currentPollSourceIdRef = useRef<string | null>(null);

  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // Mutations
  const uploadStart = useMutation(trpc.knowledge.uploadStart.mutationOptions());
  const uploadConfirm = useMutation(trpc.knowledge.confirm.mutationOptions());
  const uploadIndex = useMutation(trpc.knowledge.index.mutationOptions());
  const markFailed = useMutation(trpc.knowledge.markFailed.mutationOptions());

  const activeSourceId = uploadProgress?.sourceId;
  const shouldPollStatus =
    open &&
    Boolean(activeSourceId) &&
    (uploadProgress?.status === "processing" || uploadProgress?.status == null);

  const { data: polledSource } = useQuery(
    trpc.knowledge.status.queryOptions(
      { sourceId: activeSourceId ?? "" },
      {
        enabled: shouldPollStatus,
        staleTime: 0,
        refetchInterval: (query) => {
          const source = query.state.data;
          if (!source || source.status === "processing") {
            return 1500;
          }
          return false;
        },
        refetchIntervalInBackground: true,
      },
    ),
  );

  /**
   * Poll for async indexing status until complete or failed
   */
  const pollStatus = useCallback((sourceId: string, fileName: string) => {
    currentPollSourceIdRef.current = sourceId;
    setUploadProgress((current) => ({
      sourceId,
      fileName,
      stage: current?.stage ?? "Queued for background indexing",
      progress: current?.progress ?? 0,
      status: "processing",
      retryCount: current?.retryCount ?? 0,
      parserErrors: current?.parserErrors ?? [],
      chunksProcessed: current?.chunksProcessed,
      vectorsInserted: current?.vectorsInserted,
    }));
  }, []);

  useEffect(() => {
    if (!polledSource || !currentPollSourceIdRef.current) {
      return;
    }

    const sourceId = currentPollSourceIdRef.current;
    const fileName =
      uploadProgress?.fileName ?? polledSource.fileName ?? "File";

    if (polledSource.id !== sourceId) {
      return;
    }

    const statusMessage =
      polledSource.progressMessage ||
      (polledSource.status === "indexed"
        ? "Indexing complete"
        : polledSource.status === "failed"
          ? polledSource.parserErrors?.[0] || "Indexing failed"
          : "Processing and indexing");

    setUploadProgress((current) => ({
      sourceId,
      fileName: current?.fileName ?? fileName,
      stage: statusMessage,
      progress: polledSource.progress ?? current?.progress ?? 0,
      status: polledSource.status,
      retryCount: polledSource.retryCount ?? current?.retryCount ?? 0,
      parserErrors: polledSource.parserErrors ?? current?.parserErrors ?? [],
      chunksProcessed: current?.chunksProcessed,
      vectorsInserted: current?.vectorsInserted,
    }));

    if (polledSource.status === "indexed") {
      toast.success(`Successfully indexed ${fileName}`);
      void queryClient.invalidateQueries({
        queryKey: trpc.knowledge.list.queryKey({ agentId }),
      });
      void queryClient.invalidateQueries({
        queryKey: trpc.agent.getKnowledgeSources.queryKey({ agentId }),
      });

      const timer = setTimeout(() => {
        currentPollSourceIdRef.current = null;
        setUploadProgress(null);
        setOpen(false);
      }, 1500);

      return () => clearTimeout(timer);
    }

    if (polledSource.status === "failed") {
      const errorMsg = polledSource.parserErrors?.[0] ?? "Indexing failed";
      toast.error(`Failed to index ${fileName}: ${errorMsg}`);
      currentPollSourceIdRef.current = null;
      void queryClient.invalidateQueries({
        queryKey: trpc.knowledge.list.queryKey({ agentId }),
      });
      void queryClient.invalidateQueries({
        queryKey: trpc.agent.getKnowledgeSources.queryKey({ agentId }),
      });
    }
  }, [agentId, polledSource, queryClient, trpc, uploadProgress?.fileName]);

  const handleUpload = async (files: File[]) => {
    for (const file of files) {
      let sourceId: string | undefined;
      try {
        setUploadProgress({
          sourceId,
          fileName: file.name,
          stage: "Initiating upload...",
          progress: 10,
          status: "processing",
          retryCount: 0,
          parserErrors: [],
        });

        // Step 1: Initiate upload (create knowledge source record and get presigned URL)
        const uploadResult = await uploadStart.mutateAsync({
          agentId,
          fileName: file.name,
          mime: file.type || "application/octet-stream",
          bytes: file.size,
        });

        assertUploadStartResult(uploadResult);

        sourceId = uploadResult.sourceId;

        setUploadProgress({
          sourceId,
          fileName: file.name,
          stage: "Uploading to storage...",
          progress: 30,
          status: "processing",
          retryCount: 0,
          parserErrors: [],
        });

        // Step 2: Upload file directly to R2 using presigned URL
        const uploadResponse = await fetch(uploadResult.uploadUrl, {
          method: "PUT",
          body: file,
        });

        await assertSuccessfulUploadResponse(uploadResponse);

        setUploadProgress({
          sourceId,
          fileName: file.name,
          stage: "Confirming upload...",
          progress: 50,
          status: "processing",
          retryCount: 0,
          parserErrors: [],
        });

        // Step 3: Confirm upload (sets status to 'uploaded')
        const hashBuffer = await crypto.subtle.digest(
          "SHA-256",
          await file.arrayBuffer(),
        );
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const checksum = hashArray
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");

        await uploadConfirm.mutateAsync({
          sourceId: uploadResult.sourceId,
          checksum,
        });

        setUploadProgress({
          sourceId,
          fileName: file.name,
          stage: "Processing and indexing...",
          progress: 70,
          status: "processing",
          retryCount: 0,
          parserErrors: [],
        });

        // Step 4: Trigger indexing
        // Small files (< 1MB): process synchronously with inline content
        // Large files: enqueue for async processing via Cloudflare Queues
        if (file.size < 1024 * 1024) {
          const arrayBuffer = await file.arrayBuffer();
          const uint8Array = new Uint8Array(arrayBuffer);

          const result = await uploadIndex.mutateAsync({
            sourceId: uploadResult.sourceId,
            contentBuffer: uint8Array,
          });

          setUploadProgress({
            sourceId,
            fileName: file.name,
            stage: "Complete!",
            progress: 100,
            status: "indexed",
            retryCount: 0,
            parserErrors: [],
            chunksProcessed: result.chunksProcessed,
            vectorsInserted: result.vectorsInserted,
          });

          toast.success(`Successfully uploaded and indexed ${file.name}`);
        } else {
          // Large file: enqueue and start polling
          const result = await uploadIndex.mutateAsync({
            sourceId: uploadResult.sourceId,
          });

          if ("queued" in result && result.queued) {
            setUploadProgress({
              sourceId: uploadResult.sourceId,
              fileName: file.name,
              stage: "Queued for background indexing",
              progress: 0,
              status: "processing",
              retryCount: 0,
              parserErrors: [],
            });

            toast.info(`${file.name} uploaded. Indexing in background...`);

            // Start polling for progress
            pollStatus(uploadResult.sourceId, file.name);
            // Don't close the dialog - let polling handle it
            return;
          }

          // If not queued (shouldn't happen for large files, but handle gracefully)
          setUploadProgress({
            sourceId: uploadResult.sourceId,
            fileName: file.name,
            stage: "Complete!",
            progress: 100,
            status: "indexed",
            retryCount: 0,
            parserErrors: [],
            chunksProcessed: result.chunksProcessed,
            vectorsInserted: result.vectorsInserted,
          });
          toast.success(`Successfully uploaded and indexed ${file.name}`);
        }
      } catch (error) {
        console.error("Upload failed:", error);
        currentPollSourceIdRef.current = null;
        const errorMessage =
          error instanceof Error ? error.message : "Upload failed";
        setUploadProgress((current) => ({
          sourceId,
          fileName: file.name,
          stage: errorMessage,
          progress: current?.progress ?? 0,
          status: "failed",
          retryCount: current?.retryCount ?? 0,
          parserErrors: [errorMessage],
          chunksProcessed: current?.chunksProcessed,
          vectorsInserted: current?.vectorsInserted,
        }));

        // Mark the upload as failed in the database
        if (sourceId) {
          try {
            await markFailed.mutateAsync({
              sourceId,
              error: errorMessage,
            });
          } catch (markError) {
            console.error("Failed to mark upload as failed:", markError);
          }
        }

        toast.error(errorMessage);
        throw error;
      }
    }

    // Clear progress and refresh knowledge sources (for sync uploads)
    setUploadProgress(null);
    await queryClient.invalidateQueries({
      queryKey: trpc.agent.getKnowledgeSources.queryKey({ agentId }),
    });
    await queryClient.invalidateQueries({
      queryKey: trpc.knowledge.list.queryKey({ agentId }),
    });

    setOpen(false);
  };

  const isBusy =
    uploadStart.isPending ||
    uploadConfirm.isPending ||
    uploadIndex.isPending ||
    (uploadProgress !== null &&
      (uploadProgress.status === "processing" ||
        uploadProgress.status == null));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Upload Knowledge Sources</DialogTitle>
          <DialogDescription>
            Upload documents to enhance your agent's knowledge base. Supported
            formats: PDF, Word (.docx), Excel (.xlsx, .xls), PowerPoint, HTML,
            XML, CSV, OpenDocument (.ods, .odt), Apple Numbers, and more.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {uploadProgress && (
            <div className="mb-4 rounded-lg border bg-muted/50 p-4">
              <div className="mb-2 flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm font-medium">
                    Processing: {uploadProgress.fileName}
                  </div>
                  <div
                    className={cn(
                      "mt-1 text-xs",
                      getStatusTone(uploadProgress.status),
                    )}
                  >
                    {uploadProgress.stage}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm text-muted-foreground">
                    {Math.round(uploadProgress.progress)}%
                  </div>
                  {uploadProgress.retryCount ? (
                    <div className="mt-1 inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300">
                      <RotateCcw className="h-3 w-3" />
                      Retry {uploadProgress.retryCount}
                    </div>
                  ) : null}
                </div>
              </div>
              <Progress value={uploadProgress.progress} className="mb-3" />
              <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                {uploadProgress.status ? (
                  <span>Status: {uploadProgress.status}</span>
                ) : null}
                {typeof uploadProgress.chunksProcessed === "number" ? (
                  <span>Chunks: {uploadProgress.chunksProcessed}</span>
                ) : null}
                {typeof uploadProgress.vectorsInserted === "number" ? (
                  <span>Vectors: {uploadProgress.vectorsInserted}</span>
                ) : null}
              </div>
              {uploadProgress.parserErrors?.[0] ? (
                <div className="mt-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{uploadProgress.parserErrors[0]}</span>
                </div>
              ) : null}
              {shouldPollStatus ? (
                <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Live progress updates every 1.5 seconds
                </div>
              ) : null}
            </div>
          )}

          <FileUpload
            onUpload={handleUpload}
            disabled={isBusy}
            maxFiles={5}
            maxSize={MAX_KNOWLEDGE_FILE_SIZE}
          />
        </div>

        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => {
              currentPollSourceIdRef.current = null;
              setOpen(false);
              setUploadProgress(null);
            }}
            disabled={isBusy && !shouldPollStatus}
          >
            {shouldPollStatus ? "Close" : "Cancel"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

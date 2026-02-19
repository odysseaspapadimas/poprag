import { useMutation, useQueryClient } from "@tanstack/react-query";
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

interface KnowledgeUploadDialogProps {
  agentId: string;
  trigger: React.ReactNode;
}

export function KnowledgeUploadDialog({
  agentId,
  trigger,
}: KnowledgeUploadDialogProps) {
  const [open, setOpen] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{
    fileName: string;
    stage: string;
    progress: number;
  } | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // Mutations
  const uploadStart = useMutation(trpc.knowledge.uploadStart.mutationOptions());
  const uploadConfirm = useMutation(trpc.knowledge.confirm.mutationOptions());
  const uploadIndex = useMutation(trpc.knowledge.index.mutationOptions());
  const markFailed = useMutation(trpc.knowledge.markFailed.mutationOptions());

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  /**
   * Poll for async indexing status until complete or failed
   */
  const pollStatus = useCallback(
    (sourceId: string, fileName: string) => {
      // Clear any existing poll
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }

      pollIntervalRef.current = setInterval(async () => {
        try {
          const source = await queryClient.fetchQuery({
            ...trpc.knowledge.status.queryOptions({ sourceId }),
            staleTime: 0, // Always fetch fresh data — bypass the global 5-minute cache
          });

          if (source.status === "processing") {
            setUploadProgress({
              fileName,
              stage: `Indexing in background... (${source.progress ?? 0}%)`,
              progress: 70 + ((source.progress ?? 0) / 100) * 30, // Map 0-100% to 70-100%
            });
          } else if (source.status === "indexed") {
            // Done!
            if (pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current);
              pollIntervalRef.current = null;
            }
            setUploadProgress({
              fileName,
              stage: "Complete!",
              progress: 100,
            });
            toast.success(`Successfully indexed ${fileName}`);

            // Refresh knowledge sources list
            await queryClient.invalidateQueries({
              queryKey: trpc.knowledge.list.queryKey({ agentId }),
            });
            await queryClient.invalidateQueries({
              queryKey: trpc.agent.getKnowledgeSources.queryKey({ agentId }),
            });

            // Clear progress and close after a short delay
            setTimeout(() => {
              setUploadProgress(null);
              setOpen(false);
            }, 1500);
          } else if (source.status === "failed") {
            // Failed
            if (pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current);
              pollIntervalRef.current = null;
            }
            setUploadProgress(null);
            const errorMsg = source.parserErrors?.[0] ?? "Indexing failed";
            toast.error(`Failed to index ${fileName}: ${errorMsg}`);

            // Refresh list to show failed status
            await queryClient.invalidateQueries({
              queryKey: trpc.knowledge.list.queryKey({ agentId }),
            });
            await queryClient.invalidateQueries({
              queryKey: trpc.agent.getKnowledgeSources.queryKey({ agentId }),
            });
          }
        } catch (error) {
          console.error("Failed to poll indexing status:", error);
        }
      }, 2000); // Poll every 2 seconds
    },
    [agentId, queryClient, trpc],
  );

  const handleUpload = async (files: File[]) => {
    for (const file of files) {
      let sourceId: string | undefined;
      try {
        setUploadProgress({
          fileName: file.name,
          stage: "Initiating upload...",
          progress: 10,
        });

        // Step 1: Initiate upload (create knowledge source record and get presigned URL)
        const uploadResult = await uploadStart.mutateAsync({
          agentId,
          fileName: file.name,
          mime: file.type || "application/octet-stream",
          bytes: file.size,
        });

        if (!uploadResult) {
          console.error("Upload start data is missing");
          throw new Error("Failed to initiate upload");
        }

        sourceId = uploadResult.sourceId;

        setUploadProgress({
          fileName: file.name,
          stage: "Uploading to storage...",
          progress: 30,
        });

        // Step 2: Upload file directly to R2 using presigned URL
        const uploadResponse = await fetch(uploadResult.uploadUrl, {
          method: "PUT",
          body: file,
        });

        if (!uploadResponse.ok) {
          const errorText = await uploadResponse.text();
          throw new Error(
            `Upload failed: ${uploadResponse.statusText}${errorText ? ` - ${errorText}` : ""}`,
          );
        }

        setUploadProgress({
          fileName: file.name,
          stage: "Confirming upload...",
          progress: 50,
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
          fileName: file.name,
          stage: "Processing and indexing...",
          progress: 70,
        });

        // Step 4: Trigger indexing
        // Small files (< 1MB): process synchronously with inline content
        // Large files: enqueue for async processing via Cloudflare Queues
        if (file.size < 1024 * 1024) {
          const arrayBuffer = await file.arrayBuffer();
          const uint8Array = new Uint8Array(arrayBuffer);

          await uploadIndex.mutateAsync({
            sourceId: uploadResult.sourceId,
            contentBuffer: uint8Array,
          });

          setUploadProgress({
            fileName: file.name,
            stage: "Complete!",
            progress: 100,
          });

          toast.success(`Successfully uploaded and indexed ${file.name}`);
        } else {
          // Large file: enqueue and start polling
          const result = await uploadIndex.mutateAsync({
            sourceId: uploadResult.sourceId,
          });

          if ("queued" in result && result.queued) {
            setUploadProgress({
              fileName: file.name,
              stage: "Indexing in background... (0%)",
              progress: 70,
            });

            toast.info(`${file.name} uploaded. Indexing in background...`);

            // Start polling for progress
            pollStatus(uploadResult.sourceId, file.name);
            // Don't close the dialog - let polling handle it
            return;
          }

          // If not queued (shouldn't happen for large files, but handle gracefully)
          setUploadProgress({
            fileName: file.name,
            stage: "Complete!",
            progress: 100,
          });
          toast.success(`Successfully uploaded and indexed ${file.name}`);
        }
      } catch (error) {
        console.error("Upload failed:", error);
        setUploadProgress(null);

        // Mark the upload as failed in the database
        if (sourceId) {
          try {
            await markFailed.mutateAsync({
              sourceId,
              error: error instanceof Error ? error.message : "Upload failed",
            });
          } catch (markError) {
            console.error("Failed to mark upload as failed:", markError);
          }
        }

        toast.error(error instanceof Error ? error.message : "Upload failed");
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

  const isUploading =
    uploadStart.isPending ||
    uploadConfirm.isPending ||
    uploadIndex.isPending ||
    uploadProgress !== null;

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
            <div className="mb-4 p-4 border rounded-lg bg-muted/50">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">
                  Processing: {uploadProgress.fileName}
                </span>
                <span className="text-sm text-muted-foreground">
                  {Math.round(uploadProgress.progress)}%
                </span>
              </div>
              <Progress value={uploadProgress.progress} className="mb-2" />
              <p className="text-xs text-muted-foreground">
                {uploadProgress.stage}
              </p>
            </div>
          )}

          <FileUpload
            onUpload={handleUpload}
            disabled={isUploading}
            maxFiles={5}
            maxSize={MAX_KNOWLEDGE_FILE_SIZE}
          />
        </div>

        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => {
              if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current);
                pollIntervalRef.current = null;
              }
              setOpen(false);
              setUploadProgress(null);
            }}
            disabled={isUploading && !pollIntervalRef.current}
          >
            {pollIntervalRef.current ? "Close" : "Cancel"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

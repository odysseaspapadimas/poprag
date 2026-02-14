import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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

  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // Mutations
  const uploadStart = useMutation(trpc.knowledge.uploadStart.mutationOptions());
  const uploadConfirm = useMutation(trpc.knowledge.confirm.mutationOptions());
  const uploadIndex = useMutation(trpc.knowledge.index.mutationOptions());
  const markFailed = useMutation(trpc.knowledge.markFailed.mutationOptions());

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
        // Note: With presigned URLs and signQuery=true, we don't include Content-Type
        // in headers as it's not part of the signature. R2 will infer it from the upload.
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
        // Compute SHA-256 checksum for deduplication
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

        // Step 4: Trigger indexing with direct content for small files (< 1MB)
        // This avoids the R2 download round-trip for better performance
        if (file.size < 1024 * 1024) {
          // 1MB threshold
          // Read file content as ArrayBuffer for all supported formats
          // The backend will use toMarkdown for supported formats
          const arrayBuffer = await file.arrayBuffer();
          const uint8Array = new Uint8Array(arrayBuffer);

          await uploadIndex.mutateAsync({
            sourceId: uploadResult.sourceId,
            contentBuffer: uint8Array,
          });
        } else {
          // For larger files, use the standard R2 download approach
          await uploadIndex.mutateAsync({
            sourceId: uploadResult.sourceId,
          });
        }

        setUploadProgress({
          fileName: file.name,
          stage: "Complete!",
          progress: 100,
        });

        toast.success(`Successfully uploaded and indexed ${file.name}`);
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

    // Clear progress and refresh knowledge sources
    setUploadProgress(null);
    await queryClient.invalidateQueries({
      queryKey: trpc.agent.getKnowledgeSources.queryKey({ agentId }),
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
                  {uploadProgress.progress}%
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
            maxSize={10 * 1024 * 1024} // 10MB
          />
        </div>

        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setOpen(false);
              setUploadProgress(null);
            }}
            disabled={isUploading}
          >
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

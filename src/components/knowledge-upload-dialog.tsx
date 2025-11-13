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
import { useTRPC } from "@/integrations/trpc/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

interface KnowledgeUploadDialogProps {
  agentId: string;
  trigger: React.ReactNode;
}

export function KnowledgeUploadDialog({
  agentId,
  trigger,
}: KnowledgeUploadDialogProps) {
  const [open, setOpen] = useState(false);

  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // Mutations
  const uploadStart = useMutation(trpc.knowledge.uploadStart.mutationOptions());
  const uploadConfirm = useMutation(trpc.knowledge.confirm.mutationOptions());
  const uploadIndex = useMutation(trpc.knowledge.index.mutationOptions());

  const handleUpload = async (files: File[]) => {
    for (const file of files) {
      try {
        // Step 1: Initiate upload (create knowledge source record)
        const uploadResult = await uploadStart.mutateAsync({
          agentId,
          fileName: file.name,
          mime: file.type || "application/octet-stream",
          bytes: file.size,
        });

        console.log("Upload start data:", uploadResult);

        if (!uploadResult) {
          console.error("Upload start data is missing");
          throw new Error("Failed to initiate upload");
        }

        // Step 2: Upload file to R2 via our API endpoint
        const formData = new FormData();
        formData.append("file", file);
        formData.append("sourceId", uploadResult.sourceId);

        const uploadResponse = await fetch("/api/upload-knowledge", {
          method: "POST",
          body: formData,
        });

        if (!uploadResponse.ok) {
          const errorData = (await uploadResponse.json()) as { error?: string };
          throw new Error(errorData.error || "Upload failed");
        }

        const uploadData = (await uploadResponse.json()) as {
          checksum?: string;
        };

        // Step 3: Confirm upload and trigger indexing
        await uploadConfirm.mutateAsync({
          sourceId: uploadResult.sourceId,
          checksum: uploadData.checksum,
        });

        // Step 4: Trigger indexing
        await uploadIndex.mutateAsync({
          sourceId: uploadResult.sourceId,
        });

        toast.success(`Successfully uploaded and indexed ${file.name}`);
      } catch (error) {
        console.error("Upload failed:", error);
        toast.error(error instanceof Error ? error.message : "Upload failed");
        throw error;
      }
    }

    // Refresh knowledge sources
    await queryClient.invalidateQueries({
      queryKey: trpc.agent.getKnowledgeSources.queryKey({ agentId }),
    });

    setOpen(false);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Upload Knowledge Sources</DialogTitle>
          <DialogDescription>
            Upload documents to enhance your agent's knowledge base. Supported
            formats: PDF, TXT, MD, DOC, DOCX, CSV, JSON.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          <FileUpload
            onUpload={handleUpload}
            disabled={
              uploadStart.isPending ||
              uploadConfirm.isPending ||
              uploadIndex.isPending
            }
            maxFiles={5}
            maxSize={10 * 1024 * 1024} // 10MB
          />
        </div>

        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={
              uploadStart.isPending ||
              uploadConfirm.isPending ||
              uploadIndex.isPending
            }
          >
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

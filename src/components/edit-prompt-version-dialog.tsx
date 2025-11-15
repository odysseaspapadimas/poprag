import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { PromptVersion } from "@/db/schema";
import { useTRPC } from "@/integrations/trpc/react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import React, { useState } from "react";
import { toast } from "sonner";

interface EditPromptVersionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  version: PromptVersion | null;
  onSuccess: () => void;
}

export function EditPromptVersionDialog({
  open,
  onOpenChange,
  version,
  onSuccess,
}: EditPromptVersionDialogProps) {
  const trpc = useTRPC();
  const [content, setContent] = useState("");
  const [changelog, setChangelog] = useState("");

  const updateVersionMutation = useMutation(
    trpc.prompt.updateVersion.mutationOptions({
      onSuccess: () => {
        toast.success("Prompt version updated successfully");
        onSuccess();
        onOpenChange(false);
        resetForm();
      },
      onError: (error) => {
        toast.error(`Failed to update version: ${error.message}`);
      },
    })
  );

  const resetForm = () => {
    setContent("");
    setChangelog("");
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) resetForm();
    onOpenChange(newOpen);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!version || !content.trim()) return;

    updateVersionMutation.mutate({
      promptId: version.promptId,
      version: version.version,
      content: content.trim(),
      changelog: changelog.trim() || undefined,
    });
  };

  // Update form when version changes
  React.useEffect(() => {
    if (version) {
      setContent(version.content);
      setChangelog(version.changelog || "");
    }
  }, [version]);

  if (!version) return null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit Prompt Version v{version.version}</DialogTitle>
          <DialogDescription>
            Update the content and changelog for this prompt version.
          </DialogDescription>
        </DialogHeader>

        {version.label !== "none" && (
          <Alert className="border-orange-200 bg-orange-50 dark:border-orange-800 dark:bg-orange-950">
            <AlertTriangle className="h-4 w-4 text-orange-600" />
            <AlertDescription className="text-orange-800 dark:text-orange-200">
              <strong>Warning:</strong> This version is currently labeled as <strong>{version.label}</strong>.
              Editing it will affect the prompt used in the {version.label} environment.
            </AlertDescription>
          </Alert>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="content">Prompt Content</Label>
            <Textarea
              id="content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Enter your prompt content here..."
              rows={10}
              className="font-mono text-sm"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="changelog">Changelog (Optional)</Label>
            <Input
              id="changelog"
              value={changelog}
              onChange={(e) => setChangelog(e.target.value)}
              placeholder="Describe what changed in this version..."
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!content.trim() || updateVersionMutation.isPending}
            >
              {updateVersionMutation.isPending ? "Updating..." : "Update Version"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
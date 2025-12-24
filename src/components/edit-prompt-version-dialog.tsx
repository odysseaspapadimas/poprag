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
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { PromptVersion } from "@/db/schema";
import { useTRPC } from "@/integrations/trpc/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import React, { useState } from "react";
import { toast } from "sonner";

interface EditPromptVersionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  version: PromptVersion | null;
  agentId?: string;
  onSuccess: () => void;
}

export function EditPromptVersionDialog({
  open,
  onOpenChange,
  version,
  agentId,
  onSuccess,
}: EditPromptVersionDialogProps) {
  const trpc = useTRPC();
  const [content, setContent] = useState("");
  const [changelog, setChangelog] = useState("");
  const [label, setLabel] = useState<"dev" | "staging" | "prod" | "none">(
    "none",
  );

  const queryClient = useQueryClient();

  const updateVersionMutation = useMutation(
    trpc.prompt.updateVersion.mutationOptions({
      onSuccess: () => {
        toast.success("Prompt version updated successfully");
        onSuccess();
        onOpenChange(false);
        resetForm();
        if (version?.promptId) {
          queryClient.invalidateQueries({
            queryKey: trpc.prompt.getVersions.queryKey({
              promptId: version.promptId,
            }),
          });
        }
        if (agentId) {
          queryClient.invalidateQueries({
            queryKey: trpc.prompt.list.queryKey({ agentId }),
          });
          queryClient.invalidateQueries({
            queryKey: trpc.agent.getSetupStatus.queryKey({ agentId }),
          });
        }
      },
      onError: (error) => {
        toast.error(`Failed to update version: ${error.message}`);
      },
    }),
  );

  const assignLabelMutation = useMutation(
    trpc.prompt.assignLabel.mutationOptions({
      onSuccess: () => {
        toast.success("Label updated successfully");
        onSuccess();
        if (version?.promptId) {
          queryClient.invalidateQueries({
            queryKey: trpc.prompt.getVersions.queryKey({
              promptId: version.promptId,
            }),
          });
        }
        if (agentId) {
          queryClient.invalidateQueries({
            queryKey: trpc.prompt.list.queryKey({ agentId }),
          });
          queryClient.invalidateQueries({
            queryKey: trpc.agent.getSetupStatus.queryKey({ agentId }),
          });
        }
      },
      onError: (error) => {
        toast.error(`Failed to update label: ${error.message}`);
      },
    }),
  );

  const resetForm = () => {
    setContent("");
    setChangelog("");
    setLabel("none");
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

    // If label changed to a non-none value, also assign the new label
    if (label !== "none" && label !== version.label) {
      assignLabelMutation.mutate({
        promptId: version.promptId,
        version: version.version,
        label: label,
      });
    }
  };

  // Update form when version changes
  React.useEffect(() => {
    if (version) {
      setContent(version.content);
      setChangelog(version.changelog || "");
      setLabel(version.label as "dev" | "staging" | "prod" | "none");
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
              <strong>Warning:</strong> This version is currently labeled as{" "}
              <strong>{version.label}</strong>. Editing it will affect the
              prompt used in the {version.label} environment.
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

          <div className="space-y-2">
            <Label htmlFor="label">Label</Label>
            <Select
              value={label}
              onValueChange={(value) =>
                setLabel(value as "dev" | "staging" | "prod" | "none")
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a label" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="dev">Dev</SelectItem>
                <SelectItem value="staging">Staging</SelectItem>
                <SelectItem value="prod">Prod</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Change the label to promote this version to a different
              environment. Only one version can have each label at a time.
            </p>
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
              disabled={
                !content.trim() ||
                updateVersionMutation.isPending ||
                assignLabelMutation.isPending
              }
            >
              {updateVersionMutation.isPending || assignLabelMutation.isPending
                ? "Updating..."
                : "Update Version"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

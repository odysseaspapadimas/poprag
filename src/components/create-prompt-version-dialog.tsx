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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { Prompt } from "@/db/schema";
import { useTRPC } from "@/integrations/trpc/react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

interface CreatePromptVersionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  prompts: Prompt[];
  onSuccess: () => void;
}

export function CreatePromptVersionDialog({
  open,
  onOpenChange,
  agentId,
  prompts,
  onSuccess,
}: CreatePromptVersionDialogProps) {
  const trpc = useTRPC();
  const [selectedPromptId, setSelectedPromptId] = useState<string>("");
  const [content, setContent] = useState("");
  const [changelog, setChangelog] = useState("");
  const [label, setLabel] = useState<"dev" | "staging" | "prod" | "none">("none");

  const createVersionMutation = useMutation(
    trpc.prompt.createVersion.mutationOptions({
      onSuccess: () => {
        toast.success("Prompt version created successfully");
        onSuccess();
        resetForm();
      },
      onError: (error) => {
        toast.error(`Failed to create version: ${error.message}`);
      },
    })
  );

  const resetForm = () => {
    setSelectedPromptId("");
    setContent("");
    setChangelog("");
    setLabel("none");
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPromptId || !content.trim()) return;

    createVersionMutation.mutate({
      promptId: selectedPromptId,
      content: content.trim(),
      changelog: changelog.trim() || undefined,
      label,
    });
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) resetForm();
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create New Prompt Version</DialogTitle>
          <DialogDescription>
            Create a new version of an existing prompt or define a new prompt type.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="prompt">Prompt Type</Label>
            <Select value={selectedPromptId} onValueChange={setSelectedPromptId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a prompt type" />
              </SelectTrigger>
              <SelectContent>
                {prompts.map((prompt) => (
                  <SelectItem key={prompt.id} value={prompt.id}>
                    {prompt.key} {prompt.description && `(${prompt.description})`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

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
            <Label htmlFor="label">Label</Label>
            <Select value={label} onValueChange={(value: any) => setLabel(value)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="dev">Development</SelectItem>
                <SelectItem value="staging">Staging</SelectItem>
                <SelectItem value="prod">Production</SelectItem>
              </SelectContent>
            </Select>
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
              disabled={!selectedPromptId || !content.trim() || createVersionMutation.isPending}
            >
              {createVersionMutation.isPending ? "Creating..." : "Create Version"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
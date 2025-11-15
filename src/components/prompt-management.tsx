import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useTRPC } from "@/integrations/trpc/react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useState } from "react";
import { CreatePromptVersionDialog } from "./create-prompt-version-dialog";
import { LabelManagement } from "./label-management";
import { PromptVersionsList } from "./prompt-versions-list";
import { Skeleton } from "./ui/skeleton";

interface PromptManagementProps {
  agentId: string;
}

type ViewMode = "versions" | "labels";

export function PromptManagement({ agentId }: PromptManagementProps) {
  const trpc = useTRPC();
  const [selectedPromptId, setSelectedPromptId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("versions");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  const { data: prompts, refetch: refetchPrompts } = useSuspenseQuery(
    trpc.prompt.list.queryOptions({ agentId })
  );

  const selectedPrompt = prompts.find((p) => p.id === selectedPromptId);

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl font-semibold">Prompt Management</h2>
          <p className="text-muted-foreground">
            Manage system prompts and their versions for this agent
          </p>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)}>
          Create New Version
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Prompts List */}
        <div className="lg:col-span-1">
          <div className="bg-card border rounded-lg p-6">
            <h3 className="text-lg font-semibold mb-2">Prompts</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Available prompts for this agent
            </p>
            <div className="space-y-2">
              {prompts.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No prompts found. Create your first prompt version.
                </p>
              ) : (
                prompts.map((prompt) => (
                  <div
                    key={prompt.id}
                    className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                      selectedPromptId === prompt.id
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-muted/50"
                    }`}
                    onClick={() => setSelectedPromptId(prompt.id)}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium capitalize">{prompt.key}</p>
                        {prompt.description && (
                          <p className="text-sm text-muted-foreground">
                            {prompt.description}
                          </p>
                        )}
                      </div>
                      <Badge variant="outline">{prompt.key}</Badge>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Prompt Details */}
        <div className="lg:col-span-2">
          {selectedPrompt ? (
            <div className="space-y-4">
              <div className="flex gap-2">
                <Button
                  variant={viewMode === "versions" ? "default" : "outline"}
                  onClick={() => setViewMode("versions")}
                >
                  Versions
                </Button>
                <Button
                  variant={viewMode === "labels" ? "default" : "outline"}
                  onClick={() => setViewMode("labels")}
                >
                  Labels
                </Button>
              </div>

              {viewMode === "versions" && (
                <Suspense fallback={<Skeleton className="h-96 w-full" />}>
                  <PromptVersionsList
                    promptId={selectedPrompt.id}
                    onCreateNew={() => setCreateDialogOpen(true)}
                  />
                </Suspense>
              )}

              {viewMode === "labels" && (
                <LabelManagement promptId={selectedPrompt.id} />
              )}
            </div>
          ) : (
            <div className="bg-card border rounded-lg p-6 flex items-center justify-center h-64">
              <p className="text-muted-foreground">
                Select a prompt to view its versions and manage labels
              </p>
            </div>
          )}
        </div>
      </div>

      <CreatePromptVersionDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        agentId={agentId}
        prompts={prompts}
        onSuccess={() => {
          refetchPrompts();
          setCreateDialogOpen(false);
        }}
      />
    </div>
  );
}

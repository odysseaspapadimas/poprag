import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { PromptVersion } from "@/db/schema";
import { useTRPC } from "@/integrations/trpc/react";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Edit, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EditPromptVersionDialog } from "./edit-prompt-version-dialog";

interface PromptVersionsListProps {
  promptId: string;
  onCreateNew: () => void;
}

export function PromptVersionsList({ promptId, onCreateNew }: PromptVersionsListProps) {
  const trpc = useTRPC();
  const [editingVersion, setEditingVersion] = useState<PromptVersion | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);

  const { data: versions, refetch: refetchVersions } = useSuspenseQuery(
    trpc.prompt.getVersions.queryOptions({ promptId })
  );

  const deleteVersionMutation = useMutation(
    trpc.prompt.deleteVersion.mutationOptions({
      onSuccess: () => {
        toast.success("Prompt version deleted successfully");
        refetchVersions();
      },
      onError: (error) => {
        toast.error(`Failed to delete version: ${error.message}`);
      },
    })
  );

  const getLabelColor = (label: string) => {
    switch (label) {
      case "prod":
        return "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200";
      case "staging":
        return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200";
      case "dev":
        return "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200";
      default:
        return "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200";
    }
  };

  const handleEdit = (version: PromptVersion) => {
    setEditingVersion(version);
    setEditDialogOpen(true);
  };

  const handleDelete = (version: PromptVersion) => {
    deleteVersionMutation.mutate({
      promptId: version.promptId,
      version: version.version,
    });
  };

  const canEditOrDelete = (version: PromptVersion) => {
    return version.label === "none";
  };

  const canEdit = (version: PromptVersion) => {
    // Allow editing all versions, but show warnings for labeled ones
    return true;
  };

  return (
    <>
      <div className="bg-card border rounded-lg p-6">
        <div className="flex justify-between items-center mb-4">
          <div>
            <h3 className="text-lg font-semibold">Prompt Versions</h3>
            <p className="text-sm text-muted-foreground">
              Version history and management
            </p>
          </div>
          <Button onClick={onCreateNew} size="sm">
            New Version
          </Button>
        </div>

        {versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No versions found. Create the first version.
          </p>
        ) : (
          <div className="space-y-4 max-h-96 overflow-y-auto">
            {versions.map((version) => (
              <div
                key={version.id}
                className="border rounded-lg p-4 space-y-3"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">v{version.version}</span>
                    <Badge className={getLabelColor(version.label)}>
                      {version.label}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">
                      {formatDistanceToNow(new Date(version.createdAt), { addSuffix: true })}
                    </span>
                    {canEditOrDelete(version) && (
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleEdit(version)}
                        >
                          <Edit className="w-4 h-4" />
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="ghost" size="sm">
                              <Trash2 className="w-4 h-4 text-destructive" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete Version</AlertDialogTitle>
                              <AlertDialogDescription>
                                Are you sure you want to delete version v{version.version}?
                                This action cannot be undone.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => handleDelete(version)}
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              >
                                Delete
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    )}
                    {canEdit(version) && !canEditOrDelete(version) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleEdit(version)}
                        title={`Edit version v${version.version} (${version.label})`}
                      >
                        <Edit className="w-4 h-4 text-orange-500" />
                      </Button>
                    )}
                  </div>
                </div>

                {version.changelog && (
                  <div>
                    <p className="text-sm font-medium">Changelog:</p>
                    <p className="text-sm text-muted-foreground">
                      {version.changelog}
                    </p>
                  </div>
                )}

                <div>
                  <p className="text-sm font-medium mb-2">Content:</p>
                  <pre className="text-xs bg-muted p-3 rounded font-mono whitespace-pre-wrap overflow-x-auto">
                    {version.content}
                  </pre>
                </div>

                {version.variables && Object.keys(version.variables).length > 0 && (
                  <div>
                    <p className="text-sm font-medium mb-2">Variables:</p>
                    <div className="flex flex-wrap gap-1">
                      {Object.keys(version.variables).map((key) => (
                        <Badge key={key} variant="outline" className="text-xs">
                          {key}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <EditPromptVersionDialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        version={editingVersion}
        onSuccess={refetchVersions}
      />
    </>
  );
}
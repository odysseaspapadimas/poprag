import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useTRPC } from "@/integrations/trpc/react";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { toast } from "sonner";

interface LabelManagementProps {
  promptId: string;
}

export function LabelManagement({ promptId }: LabelManagementProps) {
  const trpc = useTRPC();

  const { data: versions, refetch: refetchVersions } = useSuspenseQuery(
    trpc.prompt.getVersions.queryOptions({ promptId })
  );

  const assignLabelMutation = useMutation(
    trpc.prompt.assignLabel.mutationOptions({
      onSuccess: () => {
        toast.success("Label assigned successfully");
        refetchVersions();
      },
      onError: (error) => {
        toast.error(`Failed to assign label: ${error.message}`);
      },
    })
  );

  const rollbackLabelMutation = useMutation(
    trpc.prompt.rollbackLabel.mutationOptions({
      onSuccess: () => {
        toast.success("Label rolled back successfully");
        refetchVersions();
      },
      onError: (error) => {
        toast.error(`Failed to rollback label: ${error.message}`);
      },
    })
  );

  const getCurrentVersionForLabel = (label: "dev" | "staging" | "prod") => {
    return versions.find(v => v.label === label);
  };

  const handleAssignLabel = (label: "dev" | "staging" | "prod", version: number) => {
    assignLabelMutation.mutate({ promptId, label, version });
  };

  const handleRollbackLabel = (label: "dev" | "staging" | "prod", toVersion: number) => {
    rollbackLabelMutation.mutate({ promptId, label, toVersion });
  };

  const labels: Array<"dev" | "staging" | "prod"> = ["dev", "staging", "prod"];

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

  return (
    <div className="bg-card border rounded-lg p-6">
      <div className="mb-4">
        <h3 className="text-lg font-semibold">Label Management</h3>
        <p className="text-sm text-muted-foreground">
          Assign and manage version labels for deployment environments
        </p>
      </div>

      <div className="space-y-6">
        {labels.map((label) => {
          const currentVersion = getCurrentVersionForLabel(label);
          const availableVersions = versions.filter(v => v.label === "none" || v.label === label);

          return (
            <div key={label} className="border rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <h4 className="font-medium capitalize">{label} Environment</h4>
                  {currentVersion && (
                    <Badge className={getLabelColor(label)}>
                      v{currentVersion.version}
                    </Badge>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-4">
                <div className="flex-1">
                  <Select
                    value={currentVersion?.version.toString() || ""}
                    onValueChange={(value) => {
                      const version = parseInt(value);
                      if (currentVersion?.version === version) return;
                      handleAssignLabel(label, version);
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={`Select ${label} version`} />
                    </SelectTrigger>
                    <SelectContent>
                      {availableVersions.map((version) => (
                        <SelectItem key={version.id} value={version.version.toString()}>
                          v{version.version} {version.changelog && `(${version.changelog})`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {currentVersion && (
                  <div className="flex gap-2">
                    <Select
                      onValueChange={(value) => {
                        const toVersion = parseInt(value);
                        handleRollbackLabel(label, toVersion);
                      }}
                    >
                      <SelectTrigger className="w-32">
                        <SelectValue placeholder="Rollback" />
                      </SelectTrigger>
                      <SelectContent>
                        {versions
                          .filter(v => v.version < currentVersion.version)
                          .map((version) => (
                            <SelectItem key={version.id} value={version.version.toString()}>
                              v{version.version}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>

              {currentVersion && (
                <div className="mt-3 text-sm text-muted-foreground">
                  <p>Content preview: {currentVersion.content.slice(0, 100)}...</p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-6 p-4 bg-muted rounded-lg">
        <h4 className="font-medium mb-2">Label Guidelines</h4>
        <ul className="text-sm text-muted-foreground space-y-1">
          <li><strong>Dev:</strong> Latest development version for testing</li>
          <li><strong>Staging:</strong> Stable version ready for production testing</li>
          <li><strong>Prod:</strong> Live production version used by the agent</li>
        </ul>
      </div>
    </div>
  );
}
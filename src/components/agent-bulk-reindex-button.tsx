import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useTRPC } from "@/integrations/trpc/react";

interface AgentBulkReindexButtonProps {
  agentId: string;
  agentName: string;
  knowledgeSourceCount: number;
}

export function AgentBulkReindexButton({
  agentId,
  agentName,
  knowledgeSourceCount,
}: AgentBulkReindexButtonProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const toastId = `reindex-agent-${agentId}`;

  const reindexMutation = useMutation(
    trpc.knowledge.bulkReindexByAgent.mutationOptions({
      onMutate: () => {
        toast.loading(`Queueing re-index for ${agentName}...`, {
          id: toastId,
          description: `Re-processing ${knowledgeSourceCount} knowledge source${knowledgeSourceCount === 1 ? "" : "s"}.`,
        });
      },
      onSuccess: (result) => {
        toast.success(
          `Queued re-index for ${result.successful}/${result.total} source${result.total === 1 ? "" : "s"}`,
          {
            id: toastId,
            description:
              result.failed > 0
                ? `${result.failed} source${result.failed === 1 ? "" : "s"} could not be queued.`
                : "Watch each source row for live progress and retry details.",
          },
        );

        queryClient.invalidateQueries({
          queryKey: trpc.agent.getKnowledgeSources.queryKey({ agentId }),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.agent.getAuditLog.queryKey({ agentId, limit: 20 }),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.knowledge.healthOverview.queryKey({}),
        });
      },
      onError: (error) => {
        toast.error(`Agent re-index failed: ${error.message}`, {
          id: toastId,
        });
      },
    }),
  );

  const handleReindex = () => {
    if (knowledgeSourceCount === 0) {
      toast.error("No knowledge sources to re-index");
      return;
    }

    reindexMutation.mutate({ agentId });
  };

  return (
    <Button
      variant="outline"
      onClick={handleReindex}
      disabled={reindexMutation.isPending || knowledgeSourceCount === 0}
    >
      {reindexMutation.isPending ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <RefreshCw className="h-4 w-4" />
      )}
      Re-index Agent
    </Button>
  );
}

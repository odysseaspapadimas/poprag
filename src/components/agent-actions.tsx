import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Agent } from "@/db/schema";
import { useTRPC } from "@/integrations/trpc/react";

interface AgentActionsProps {
  agent: Agent;
}

export function AgentActions({ agent }: AgentActionsProps) {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const updateAgent = useMutation(
    trpc.agent.update.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.agent.list.queryKey() });
        queryClient.invalidateQueries({
          queryKey: trpc.agent.getSetupStatus.queryKey({ agentId: agent.id }),
        });
        toast.success("Agent updated");
      },
      onError: (err: any) => {
        toast.error(`Failed to update agent: ${err.message}`);
      },
    }),
  );

  const archiveAgent = useMutation(
    trpc.agent.archive.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.agent.list.queryKey() });
        queryClient.invalidateQueries({
          queryKey: trpc.agent.getSetupStatus.queryKey({ agentId: agent.id }),
        });
        toast.success("Agent archived");
      },
      onError: (err: any) => {
        toast.error(`Failed to archive agent: ${err.message}`);
      },
    }),
  );

  const handleToggleStatus = () => {
    const newStatus = agent.status === "active" ? "draft" : "active";
    updateAgent.mutate({ id: agent.id, status: newStatus });
  };

  const handleCycleVisibility = () => {
    const next: Record<string, string> = {
      private: "workspace",
      workspace: "public",
      public: "private",
    };
    const newVis = next[agent.visibility];
    updateAgent.mutate({ id: agent.id, visibility: newVis as any });
  };

  const handleArchive = () => {
    archiveAgent.mutate({ id: agent.id });
    setConfirmOpen(false);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-8 w-8 p-0">
          <span className="sr-only">Open menu</span>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Actions</DropdownMenuLabel>
        <DropdownMenuItem
          onClick={() =>
            navigate({ to: `/agents/${agent.id}`, search: { tab: "overview" } })
          }
        >
          View Details
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => navigator.clipboard.writeText(agent.id)}
        >
          Copy agent ID
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleToggleStatus}>
          {agent.status === "active" ? "Make Draft" : "Make Active"}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleCycleVisibility}>
          Change Visibility ({agent.visibility})
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => setConfirmOpen(true)}
          className="text-destructive"
        >
          Delete / Archive
        </DropdownMenuItem>
      </DropdownMenuContent>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogTrigger asChild>
          {/* Hidden trigger; handled by dropdown */}
          <span />
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Agent</AlertDialogTitle>
            <p>
              Are you sure you want to delete (archive) this agent? This will
              archive the agent and cannot be undone.
            </p>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleArchive}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DropdownMenu>
  );
}

export default AgentActions;

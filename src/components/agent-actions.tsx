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
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

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
        setArchiveDialogOpen(false);
      },
      onError: (err: any) => {
        toast.error(`Failed to archive agent: ${err.message}`);
      },
    }),
  );

  const deleteAgent = useMutation(
    trpc.agent.delete.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.agent.list.queryKey() });
        toast.success("Agent permanently deleted");
        setDeleteDialogOpen(false);
      },
      onError: (err: any) => {
        toast.error(`Failed to delete agent: ${err.message}`);
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
  };

  const handleDelete = () => {
    deleteAgent.mutate({ id: agent.id });
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
        {agent.status !== "archived" && (
          <DropdownMenuItem
            onClick={() => setArchiveDialogOpen(true)}
            className="text-destructive"
          >
            Archive
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={() => setDeleteDialogOpen(true)}
          className="text-destructive"
        >
          Delete Permanently
        </DropdownMenuItem>
      </DropdownMenuContent>

      <AlertDialog open={archiveDialogOpen} onOpenChange={setArchiveDialogOpen}>
        <AlertDialogTrigger asChild>
          {/* Hidden trigger; handled by dropdown */}
          <span />
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive Agent</AlertDialogTitle>
            <p>
              Are you sure you want to archive this agent? The agent will be
              hidden from the main list but can be restored later.
            </p>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleArchive}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogTrigger asChild>
          {/* Hidden trigger; handled by dropdown */}
          <span />
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Agent Permanently</AlertDialogTitle>
            <p>
              Are you sure you want to permanently delete this agent? This
              action cannot be undone and all associated data will be lost.
            </p>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete Permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DropdownMenu>
  );
}

export default AgentActions;

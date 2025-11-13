import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
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
import type { KnowledgeSource } from "@/db/schema";
import { useTRPC } from "@/integrations/trpc/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

interface KnowledgeSourceActionsProps {
  source: KnowledgeSource;
  agentId: string;
}

export function KnowledgeSourceActions({
  source,
  agentId,
}: KnowledgeSourceActionsProps) {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // Mutations
  const reindexMutation = useMutation(
    trpc.knowledge.index.mutationOptions({
      onSuccess: () => {
        toast.success("Knowledge source re-indexed successfully");
        queryClient.invalidateQueries({
          queryKey: trpc.agent.getKnowledgeSources.queryKey({ agentId }),
        });
      },
      onError: (error) => {
        toast.error(`Re-indexing failed: ${error.message}`);
      },
    })
  );

  const deleteMutation = useMutation(
    trpc.knowledge.delete.mutationOptions({
      onSuccess: () => {
        toast.success("Knowledge source deleted successfully");
        queryClient.invalidateQueries({
          queryKey: trpc.agent.getKnowledgeSources.queryKey({ agentId }),
        });
        setDeleteDialogOpen(false);
      },
      onError: (error) => {
        toast.error(`Deletion failed: ${error.message}`);
      },
    })
  );

  const handleReindex = () => {
    reindexMutation.mutate({
      sourceId: source.id,
      reindex: true,
    });
  };

  const handleDelete = () => {
    deleteMutation.mutate({
      sourceId: source.id,
    });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Actions</DropdownMenuLabel>
          <DropdownMenuItem
            onClick={handleReindex}
            disabled={reindexMutation.isPending}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            {reindexMutation.isPending ? "Re-indexing..." : "Re-index"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => setDeleteDialogOpen(true)}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Knowledge Source</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{source.fileName}"? This action
              cannot be undone and will remove this knowledge source from your
              agent's knowledge base.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
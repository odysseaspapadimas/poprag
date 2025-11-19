import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger, } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTRPC } from "@/integrations/trpc/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

interface ModelAliasActionsProps {
  alias: {
    alias: string;
    provider: string;
    modelId: string;
  };
  onEdit: () => void;
}

export function ModelAliasActions({ alias, onEdit }: ModelAliasActionsProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const deleteMutation = useMutation(trpc.model.delete.mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.model.list.queryKey() });
      toast.success("Model alias deleted");
    },
    onError: (err: any) => {
      toast.error(`Failed to delete alias: ${err.message}`);
    },
  }));

  const handleDelete = async () => {
    if (!confirm(`Delete alias ${alias.alias}?`)) return;
    await deleteMutation.mutateAsync({ alias: alias.alias });
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
        <DropdownMenuItem onClick={onEdit}>
          Edit
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigator.clipboard.writeText(alias.alias)}>
          Copy alias
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => setConfirmOpen(true)} className="text-destructive">
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogTrigger asChild>
          {/* Hidden trigger; handled by dropdown */}
          <span />
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Model Alias</AlertDialogTitle>
            <p>
              Are you sure you want to delete the alias "{alias.alias}"? This action cannot be undone.
            </p>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DropdownMenu>
  );
}

export default ModelAliasActions;
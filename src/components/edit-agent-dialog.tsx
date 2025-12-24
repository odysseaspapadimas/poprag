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
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import {
    Form,
    FormControl,
    FormDescription,
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { Agent } from "@/db/schema";
import { useTRPC } from "@/integrations/trpc/react";
import { zodResolver } from "@hookform/resolvers/zod";
import {
    useMutation,
    useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

const editAgentSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  description: z.string().optional(),
  status: z.enum(["draft", "active", "archived"]),
  visibility: z.enum(["private", "workspace", "public"]),
});

type EditAgentForm = z.infer<typeof editAgentSchema>;

interface EditAgentDialogProps {
  agent: Agent;
  trigger: React.ReactNode;
}

export function EditAgentDialog({ agent, trigger }: EditAgentDialogProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [showArchiveDialog, setShowArchiveDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  // Form setup
  const form = useForm<EditAgentForm>({
    resolver: zodResolver(editAgentSchema),
    defaultValues: {
      name: agent.name,
      description: agent.description || "",
      status: agent.status,
      visibility: agent.visibility,
    },
  });

  // Update agent mutation
  const updateAgent = useMutation(
    trpc.agent.update.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: trpc.agent.get.queryKey({ id: agent.id }),
        });
        queryClient.invalidateQueries({ queryKey: trpc.agent.list.queryKey() });
        queryClient.invalidateQueries({
          queryKey: trpc.agent.getSetupStatus.queryKey({ agentId: agent.id }),
        });
        setOpen(false);
        toast.success("Agent updated");
      },
      onError: (err: any) => {
        toast.error(`Failed to update agent: ${err?.message ?? err}`);
      },
    }),
  );

  // Archive agent mutation
  const archiveAgent = useMutation(
    trpc.agent.archive.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: trpc.agent.get.queryKey({ id: agent.id }),
        });
        queryClient.invalidateQueries({ queryKey: trpc.agent.list.queryKey() });
        queryClient.invalidateQueries({
          queryKey: trpc.agent.getSetupStatus.queryKey({ agentId: agent.id }),
        });
        setShowArchiveDialog(false);
        toast.success("Agent archived");
      },
      onError: (err: any) => {
        toast.error(`Failed to archive agent: ${err?.message ?? err}`);
      },
    }),
  );

  // Delete agent mutation
  const deleteAgent = useMutation(
    trpc.agent.delete.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.agent.list.queryKey() });
        setShowDeleteDialog(false);
        toast.success("Agent permanently deleted");
        // Navigate away since agent is deleted
        navigate({ to: "/agents" });
      },
      onError: (err: any) => {
        toast.error(`Failed to delete agent: ${err?.message ?? err}`);
      },
    }),
  );

  const onSubmit = (data: EditAgentForm) => {
    updateAgent.mutate({
      id: agent.id,
      ...data,
    });
  };

  const handleArchive = () => {
    archiveAgent.mutate({ id: agent.id });
  };

  const handleDelete = () => {
    deleteAgent.mutate({ id: agent.id });
  };

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <div onClick={() => setOpen(true)}>{trigger}</div>
        </DialogTrigger>
        <DialogContent className="sm:max-w-[525px] max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Agent Settings</DialogTitle>
            <DialogDescription>
              Update your agent's basic information and settings.
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input placeholder="My Support Agent" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Description</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="A helpful AI assistant for customer support"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="status"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Status</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      defaultValue={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="draft">Draft</SelectItem>
                        <SelectItem value="active">Active</SelectItem>
                        <SelectItem value="archived">Archived</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      Draft agents are not available for use. Archived agents
                      are hidden but can be restored.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="visibility"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Visibility</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      defaultValue={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="private">Private</SelectItem>
                        <SelectItem value="workspace">Workspace</SelectItem>
                        <SelectItem value="public">Public</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      Private: Only you can see this agent. Workspace: Visible
                      to your team. Public: Anyone can see this agent.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <DialogFooter className="flex-col gap-2 sm:flex-row">
                <div className="flex gap-2">
                  {agent.status !== "archived" && (
                    <AlertDialog
                      open={showArchiveDialog}
                      onOpenChange={setShowArchiveDialog}
                    >
                      <AlertDialogTrigger asChild>
                        <Button type="button" variant="outline" size="sm">
                          Archive
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Archive Agent</AlertDialogTitle>
                          <AlertDialogDescription>
                            Are you sure you want to archive this agent? It will
                            be hidden from your agent list but can be restored
                            later.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={handleArchive}
                            className="bg-orange-600 hover:bg-orange-700"
                          >
                            Archive
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                  {agent.status === "archived" && (
                    <AlertDialog
                      open={showDeleteDialog}
                      onOpenChange={setShowDeleteDialog}
                    >
                      <AlertDialogTrigger asChild>
                        <Button type="button" variant="destructive" size="sm">
                          Delete Permanently
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            Delete Agent Permanently
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            Are you sure you want to permanently delete this
                            agent? This action cannot be undone and all
                            associated data will be lost.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={handleDelete}
                            className="bg-red-600 hover:bg-red-700"
                          >
                            Delete Permanently
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={updateAgent.isPending}>
                    {updateAgent.isPending ? "Updating..." : "Update Agent"}
                  </Button>
                </div>
              </DialogFooter>
              {updateAgent.error && (
                <p className="text-sm text-destructive">
                  Error: {updateAgent.error.message}
                </p>
              )}
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </>
  );
}

import { ExperienceForm } from "@/components/experiences/ExperienceForm";
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
import { useTRPC } from "@/integrations/trpc/react";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Copy, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

interface ExperienceListProps {
  agentId: string;
  agentSlug: string;
}

export function ExperienceList({ agentId, agentSlug }: ExperienceListProps) {
  const trpc = useTRPC();

  const { data: experiences } = useSuspenseQuery(
    trpc.experience.list.queryOptions({ agentId }),
  );

  return (
    <div className="bg-card border rounded-lg p-6">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-semibold">Experiences</h2>
        <ExperienceForm
          agentId={agentId}
          trigger={<Button>Create Experience</Button>}
        />
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Group knowledge sources into named experiences. Use{" "}
        <code className="text-xs bg-muted px-1 py-0.5 rounded">
          ?experience=slug
        </code>{" "}
        in the chat API to filter by experience.
      </p>

      {experiences.length === 0 ? (
        <p className="text-center text-muted-foreground py-8">
          No experiences yet. Create one to group knowledge sources.
        </p>
      ) : (
        <div className="space-y-4">
          {experiences.map((experience) => (
            <ExperienceRow
              key={experience.id}
              agentId={agentId}
              agentSlug={agentSlug}
              experience={experience}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface ExperienceRowProps {
  agentId: string;
  agentSlug: string;
  experience: {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    isActive: boolean;
    order: number | null;
    knowledgeSourceCount: number;
  };
}

function ExperienceRow({ agentId, agentSlug, experience }: ExperienceRowProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);

  const deleteMutation = useMutation(
    trpc.experience.delete.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: trpc.experience.list.queryKey({ agentId }),
        });
        toast.success(`Experience "${experience.name}" deleted`);
        setDeleteDialogOpen(false);
      },
      onError: (err) => {
        toast.error(`Failed to delete: ${err.message}`);
      },
    }),
  );

  const chatUrl = `/api/chat/${agentSlug}?experience=${experience.slug}`;

  return (
    <>
      <div className="flex justify-between items-center p-4 border rounded">
        <div className="min-w-0 flex-1">
          <span className="font-medium">{experience.name}</span>
          <p className="text-sm text-muted-foreground">
            {experience.slug} • {experience.knowledgeSourceCount} knowledge
            source
            {experience.knowledgeSourceCount !== 1 ? "s" : ""}
            {experience.description ? ` • ${experience.description}` : ""}
          </p>
          <div className="flex items-center gap-1.5 mt-1.5">
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono text-muted-foreground truncate max-w-[420px]">
              {chatUrl}
            </code>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(chatUrl);
                toast.success("URL copied");
              }}
              className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
              title="Copy URL"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`px-2 py-1 rounded text-xs ${
              experience.isActive
                ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                : "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200"
            }`}
          >
            {experience.isActive ? "Active" : "Inactive"}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Actions</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => setEditDialogOpen(true)}>
                <Pencil className="mr-2 h-4 w-4" />
                Edit
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
        </div>
      </div>

      {/* Edit Dialog - rendered outside the row so dropdown doesn't interfere */}
      {editDialogOpen && (
        <ExperienceForm
          agentId={agentId}
          experienceId={experience.id}
          open={editDialogOpen}
          onOpenChange={setEditDialogOpen}
        />
      )}

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Experience</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{experience.name}"? Knowledge
              sources will NOT be deleted -- only the experience grouping is
              removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate({ id: experience.id })}
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

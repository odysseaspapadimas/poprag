import { zodResolver } from "@hookform/resolvers/zod";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useTRPC } from "@/integrations/trpc/react";

const experienceSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  slug: z.string().max(100).optional(),
  description: z.string().max(1000).optional(),
  isActive: z.boolean(),
  knowledgeSourceIds: z.array(z.string()),
});

type ExperienceFormValues = z.infer<typeof experienceSchema>;

interface ExperienceFormProps {
  agentId: string;
  /** If provided, the form will be in edit mode */
  experienceId?: string;
  /** Trigger element -- if provided, dialog is self-managed via DialogTrigger */
  trigger?: React.ReactNode;
  /** Controlled open state -- use instead of trigger for external control */
  open?: boolean;
  /** Controlled open change handler */
  onOpenChange?: (open: boolean) => void;
}

export function ExperienceForm({
  agentId,
  experienceId,
  trigger,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
}: ExperienceFormProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = isControlled
    ? (controlledOnOpenChange ?? (() => {}))
    : setInternalOpen;
  const isEditing = !!experienceId;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="sm:max-w-[600px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? "Edit Experience" : "Create Experience"}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Update the experience details and knowledge source assignments."
              : "Create a new experience (knowledge group) and assign knowledge sources to it."}
          </DialogDescription>
        </DialogHeader>
        {open && (
          <ExperienceFormContent
            agentId={agentId}
            experienceId={experienceId}
            isEditing={isEditing}
            onSuccess={() => setOpen(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ExperienceFormContent({
  agentId,
  experienceId,
  isEditing,
  onSuccess,
}: {
  agentId: string;
  experienceId?: string;
  isEditing: boolean;
  onSuccess: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // Fetch knowledge sources for this agent
  const { data: knowledgeSources } = useSuspenseQuery(
    trpc.agent.getKnowledgeSources.queryOptions({ agentId }),
  );

  // Fetch experience data if editing (useQuery since it's conditional)
  const { data: experience, isLoading: isLoadingExperience } = useQuery({
    ...trpc.experience.get.queryOptions({ id: experienceId! }),
    enabled: isEditing && !!experienceId,
  });

  const form = useForm<ExperienceFormValues>({
    resolver: zodResolver(experienceSchema),
    defaultValues: {
      name: "",
      slug: "",
      description: "",
      isActive: true,
      knowledgeSourceIds: [],
    },
  });

  // Reset form when experience data loads (edit mode)
  useEffect(() => {
    if (experience) {
      form.reset({
        name: experience.name,
        slug: experience.slug,
        description: experience.description ?? "",
        isActive: experience.isActive,
        knowledgeSourceIds: experience.knowledgeSourceIds,
      });
    }
  }, [experience, form]);

  const createMutation = useMutation(
    trpc.experience.create.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: trpc.experience.list.queryKey({ agentId }),
        });
        toast.success("Experience created");
        onSuccess();
      },
      onError: (err) => {
        toast.error(`Failed to create experience: ${err.message}`);
      },
    }),
  );

  const updateMutation = useMutation(
    trpc.experience.update.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: trpc.experience.list.queryKey({ agentId }),
        });
        if (experienceId) {
          queryClient.invalidateQueries({
            queryKey: trpc.experience.get.queryKey({ id: experienceId }),
          });
        }
        toast.success("Experience updated");
        onSuccess();
      },
      onError: (err) => {
        toast.error(`Failed to update experience: ${err.message}`);
      },
    }),
  );

  const isPending = createMutation.isPending || updateMutation.isPending;

  const onSubmit = (values: ExperienceFormValues) => {
    if (isEditing && experienceId) {
      updateMutation.mutate({
        id: experienceId,
        name: values.name,
        slug: values.slug || undefined,
        description: values.description || null,
        isActive: values.isActive,
        knowledgeSourceIds: values.knowledgeSourceIds,
      });
    } else {
      createMutation.mutate({
        agentId,
        name: values.name,
        slug: values.slug || undefined,
        description: values.description || undefined,
        isActive: values.isActive,
        knowledgeSourceIds: values.knowledgeSourceIds,
      });
    }
  };

  // Show loading spinner while fetching experience data in edit mode
  if (isEditing && isLoadingExperience) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input placeholder="e.g. Math 101" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="slug"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Slug (optional)</FormLabel>
              <FormControl>
                <Input placeholder="auto-generated from name" {...field} />
              </FormControl>
              <FormDescription>
                Used in the chat API URL: ?experience=slug
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Description (optional)</FormLabel>
              <FormControl>
                <Textarea
                  placeholder="A brief description of this experience..."
                  className="resize-none"
                  rows={2}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="isActive"
          render={({ field }) => (
            <FormItem className="flex items-center justify-between rounded-lg border p-3">
              <div className="space-y-0.5">
                <FormLabel>Active</FormLabel>
                <FormDescription>
                  Inactive experiences are hidden from the chat selector
                </FormDescription>
              </div>
              <FormControl>
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />

        {/* Knowledge Source Selection */}
        <FormField
          control={form.control}
          name="knowledgeSourceIds"
          render={() => (
            <FormItem>
              <FormLabel>Knowledge Sources</FormLabel>
              <FormDescription>
                Select which knowledge sources belong to this experience.
              </FormDescription>
              {knowledgeSources.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">
                  No knowledge sources uploaded yet.
                </p>
              ) : (
                <div className="space-y-2 max-h-[200px] overflow-y-auto border rounded-md p-2">
                  {knowledgeSources.map((source) => (
                    <FormField
                      key={source.id}
                      control={form.control}
                      name="knowledgeSourceIds"
                      render={({ field }) => (
                        <FormItem className="flex items-center space-x-2 space-y-0">
                          <FormControl>
                            <Checkbox
                              checked={field.value?.includes(source.id)}
                              onCheckedChange={(checked) => {
                                const current = field.value || [];
                                if (checked) {
                                  field.onChange([...current, source.id]);
                                } else {
                                  field.onChange(
                                    current.filter((id) => id !== source.id),
                                  );
                                }
                              }}
                            />
                          </FormControl>
                          <div className="flex-1 min-w-0">
                            <span className="text-sm font-medium leading-none">
                              {source.fileName}
                            </span>
                            <span className="text-xs text-muted-foreground ml-2">
                              {source.status}
                            </span>
                          </div>
                        </FormItem>
                      )}
                    />
                  ))}
                </div>
              )}
              <FormMessage />
            </FormItem>
          )}
        />

        <DialogFooter>
          <Button type="submit" disabled={isPending}>
            {isPending
              ? isEditing
                ? "Updating..."
                : "Creating..."
              : isEditing
                ? "Update Experience"
                : "Create Experience"}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}

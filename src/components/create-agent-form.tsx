import { zodResolver } from "@hookform/resolvers/zod";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
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
import { useTRPC } from "@/integrations/trpc/react";

const createAgentSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  slug: z
    .string()
    .min(1, "Slug is required")
    .max(50)
    .regex(
      /^[a-z0-9-]+$/,
      "Slug must contain only lowercase letters, numbers, and hyphens",
    ),
  description: z.string().optional(),
  modelAlias: z.string(),
  visibility: z.enum(["private", "workspace", "public"]),
});

type CreateAgentForm = z.infer<typeof createAgentSchema>;

interface CreateAgentFormProps {
  onSuccess?: () => void;
}

export function CreateAgentForm({ onSuccess }: CreateAgentFormProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // Fetch model aliases
  const { data: modelAliases } = useSuspenseQuery(
    trpc.model.list.queryOptions(),
  );

  // Form setup
  const form = useForm<CreateAgentForm>({
    resolver: zodResolver(createAgentSchema),
    defaultValues: {
      name: "",
      slug: "",
      description: "",
      modelAlias: "gpt-4o-mini",
      visibility: "private",
    },
  });

  // Create agent mutation
  const createAgent = useMutation(
    trpc.agent.create.mutationOptions({
      onSuccess: () => {
        form.reset();
        queryClient.invalidateQueries({ queryKey: trpc.agent.list.queryKey() });
        toast.success("Agent created");
        onSuccess?.();
      },
      onError: (err: any) => {
        toast.error(`Failed to create agent: ${err?.message ?? err}`);
      },
    }),
  );

  const onSubmit = (data: CreateAgentForm) => {
    createAgent.mutate({
      ...data,
      systemPrompt:
        "You are a helpful AI assistant with access to a knowledge base. Answer questions accurately using the provided context.",
    });
  };

  // Auto-generate slug from name
  const handleNameChange = (name: string) => {
    form.setValue("name", name);
    if (!form.formState.dirtyFields.slug) {
      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
      form.setValue("slug", slug);
    }
  };

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
                <Input
                  placeholder="My Support Agent"
                  {...field}
                  onChange={(e) => handleNameChange(e.target.value)}
                />
              </FormControl>
              <FormDescription>A friendly name for your agent</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="slug"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Slug</FormLabel>
              <FormControl>
                <Input placeholder="my-support-agent" {...field} />
              </FormControl>
              <FormDescription>
                URL-friendly identifier (auto-generated from name)
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
                <Input
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
          name="modelAlias"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Model</FormLabel>
              <Select onValueChange={field.onChange} defaultValue={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a model" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {modelAliases.map((model) => (
                    <SelectItem key={model.alias} value={model.alias}>
                      {model.alias} ({model.provider})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormDescription>
                The AI model to use for this agent
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="flex justify-end gap-2">
          <button type="submit" className="hidden" />
        </div>
        <div className="flex justify-end gap-2 pt-4 border-t">
          <button
            type="button"
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
            onClick={() => onSuccess?.()}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={createAgent.isPending}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md hover:bg-blue-700 disabled:opacity-50"
          >
            {createAgent.isPending ? "Creating..." : "Create Agent"}
          </button>
        </div>
      </form>
    </Form>
  );
}

export default CreateAgentForm;

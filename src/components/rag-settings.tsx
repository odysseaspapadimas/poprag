import { zodResolver } from "@hookform/resolvers/zod";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
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
import { Switch } from "@/components/ui/switch";
import { useTRPC } from "@/integrations/trpc/react";

const ragSettingsSchema = z.object({
  ragEnabled: z.boolean(),
  rewriteQuery: z.boolean(),
  rewriteModel: z.string().optional(),
  intentModel: z.string().optional(),
  queryVariationsCount: z.number().min(1).max(10),
  rerank: z.boolean(),
  rerankModel: z.string().optional(),
  topK: z.number().min(1).max(20),
  minSimilarity: z.number().min(0).max(100), // Percentage 0-100
});

type RAGSettingsForm = z.infer<typeof ragSettingsSchema>;

interface RAGSettingsProps {
  agentId: string;
}

export function RAGSettings({ agentId }: RAGSettingsProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data: agent } = useSuspenseQuery(
    trpc.agent.get.queryOptions({ id: agentId }),
  );

  const { data: modelAliases } = useSuspenseQuery(
    trpc.model.list.queryOptions(),
  );

  const form = useForm<RAGSettingsForm>({
    resolver: zodResolver(ragSettingsSchema),
    defaultValues: {
      ragEnabled: agent?.ragEnabled ?? true,
      rewriteQuery: agent?.rewriteQuery ?? false,
      rewriteModel: agent?.rewriteModel || undefined,
      intentModel: agent?.intentModel || undefined,
      queryVariationsCount: agent?.queryVariationsCount ?? 3,
      rerank: agent?.rerank ?? false,
      rerankModel: agent?.rerank ? "@cf/baai/bge-reranker-base" : undefined,
      topK: agent?.topK ?? 5,
      minSimilarity: agent?.minSimilarity ?? 30,
    },
  });

  const updateAgent = useMutation(
    trpc.agent.update.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: trpc.agent.get.queryKey({ id: agentId }),
        });
        queryClient.invalidateQueries({ queryKey: trpc.agent.list.queryKey() });
        toast.success("RAG settings updated");
      },
      onError: (err: any) => {
        toast.error(`Failed to update RAG settings: ${err?.message ?? err}`);
      },
    }),
  );

  const onSubmit = (data: RAGSettingsForm) => {
    const submitData = { ...data };
    if (data.rerank) {
      submitData.rerankModel = "@cf/baai/bge-reranker-base";
    }
    updateAgent.mutate({
      id: agentId,
      ...submitData,
    });
  };

  if (!agent) {
    return null;
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        <FormField
          control={form.control}
          name="ragEnabled"
          render={({ field }) => (
            <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4 shadow-sm">
              <div className="space-y-0.5">
                <FormLabel className="text-base">Enable RAG</FormLabel>
                <FormDescription>
                  Allow the agent to search and retrieve information from
                  knowledge sources
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

        {form.watch("ragEnabled") && (
          <>
            <FormField
              control={form.control}
              name="intentModel"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Intent Classification Model</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    defaultValue={field.value}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a model for intent classification" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {modelAliases.map((model) => (
                        <SelectItem key={model.alias} value={model.alias}>
                          {model.alias}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Model used to determine if a query needs knowledge base
                    search (smaller = faster)
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="rewriteQuery"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4 shadow-sm">
                  <div className="space-y-0.5">
                    <FormLabel className="text-base">Query Rewriting</FormLabel>
                    <FormDescription>
                      Improve search results by expanding and rewriting user
                      queries into multiple variations
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

            {form.watch("rewriteQuery") && (
              <>
                <FormField
                  control={form.control}
                  name="rewriteModel"
                  render={({ field }) => (
                    <FormItem className="ml-4">
                      <FormLabel>Query Rewrite Model</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        defaultValue={field.value}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select a model for query rewriting" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {modelAliases.map((model) => (
                            <SelectItem key={model.alias} value={model.alias}>
                              {model.alias}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormDescription>
                        The model used to generate query variations for better
                        recall
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="queryVariationsCount"
                  render={({ field }) => (
                    <FormItem className="ml-4">
                      <FormLabel>Query Variations Count</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={1}
                          max={10}
                          {...field}
                          onChange={(e) =>
                            field.onChange(Number(e.target.value))
                          }
                        />
                      </FormControl>
                      <FormDescription>
                        Number of query variations to generate (2-3 for speed,
                        4-5 for coverage)
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </>
            )}

            <FormField
              control={form.control}
              name="rerank"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4 shadow-sm">
                  <div className="space-y-0.5">
                    <FormLabel className="text-base">
                      Result Reranking
                    </FormLabel>
                    <FormDescription>
                      Re-order search results using a cross-encoder model for
                      improved relevance
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

            {form.watch("rerank") && (
              <FormField
                control={form.control}
                name="rerankModel"
                render={({ field }) => (
                  <FormItem className="ml-4">
                    <FormLabel>Reranker Model</FormLabel>
                    <FormControl>
                      <Input value="@cf/baai/bge-reranker-base" disabled />
                    </FormControl>
                    <FormDescription>
                      Fixed reranker model used for reordering search results
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <div className="rounded-lg border p-4 shadow-sm space-y-4">
              <h3 className="text-base font-medium">Search Performance</h3>

              <FormField
                control={form.control}
                name="topK"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Top K Results</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        max={20}
                        {...field}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription>
                      Number of chunks to retrieve from vector search (1-5 for
                      speed, 5-10 for coverage)
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="minSimilarity"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Minimum Similarity (%)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        {...field}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription>
                      Filter out results below this similarity threshold (30-40%
                      for broader recall, 50-70% for precision)
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </>
        )}

        <div className="flex justify-end">
          <Button type="submit" disabled={updateAgent.isPending}>
            {updateAgent.isPending ? "Saving..." : "Save RAG Settings"}
          </Button>
        </div>
      </form>
    </Form>
  );
}

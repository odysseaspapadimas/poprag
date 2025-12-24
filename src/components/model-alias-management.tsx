import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTRPC } from "@/integrations/trpc/react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { AudioLines, FileText, Image, Video } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import ModelAliasActions from "./model-alias-actions";
import { columns, type ModelAliasRow } from "./tables/columns-models";
import { DataTable } from "./tables/data-table";

// Map external provider to our internal provider type
const PROVIDER_MAPPING: Record<
  string,
  "openai" | "openrouter" | "huggingface" | "cloudflare-workers-ai"
> = {
  openai: "openai",
  anthropic: "openrouter",
  google: "openrouter",
  mistral: "openrouter",
  meta: "openrouter",
  cohere: "openrouter",
  deepseek: "openrouter",
  groq: "openrouter",
  "together-ai": "openrouter",
  perplexity: "openrouter",
  fireworks: "openrouter",
  xai: "openrouter",
  openrouter: "openrouter",
  "huggingface-inference": "huggingface",
  "cloudflare-workers-ai": "cloudflare-workers-ai",
};

interface EditModalState {
  open: boolean;
  selected: ModelAliasRow | null;
  form: {
    alias: string;
    provider: string;
    modelId: string;
    modelsDevId: string;
  };
}

export function ModelAliasManagement() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data: aliases } = useSuspenseQuery(trpc.model.list.queryOptions());

  const [editModalState, setEditModalState] = useState<EditModalState>({
    open: false,
    selected: null,
    form: { alias: "", provider: "", modelId: "", modelsDevId: "" },
  });

  const [modelSearch, setModelSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");

  const updateMutation = useMutation(
    trpc.model.update.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.model.list.queryKey() });
        toast.success("Model alias updated");
        setEditModalState((prev) => ({ ...prev, open: false }));
      },
      onError: (err) => {
        toast.error(`Failed to update alias: ${err.message}`);
      },
    }),
  );

  // Query for models
  const { data: modelsDevModels, isLoading: isLoadingModels } = useQuery({
    ...trpc.model.searchModels.queryOptions({
      query: modelSearch || undefined,
      provider: providerFilter !== "all" ? providerFilter : undefined,
      excludeDeprecated: true,
      limit: 50,
    }),
    enabled:
      editModalState.open &&
      (modelSearch.length > 0 || providerFilter !== "all"),
  });

  // Query for available providers
  const { data: providers } = useQuery({
    ...trpc.model.listProviders.queryOptions(),
    enabled: editModalState.open,
  });

  const handleEditSubmit = async () => {
    try {
      await updateMutation.mutateAsync({
        alias: editModalState.selected!.alias,
        newAlias:
          editModalState.form.alias !== editModalState.selected!.alias
            ? editModalState.form.alias
            : undefined,
        provider:
          editModalState.form.provider !== editModalState.selected!.provider
            ? (editModalState.form.provider as "openai" | "openrouter" | "huggingface" | "cloudflare-workers-ai")
            : undefined,
        modelId:
          editModalState.form.modelId !== editModalState.selected!.modelId
            ? editModalState.form.modelId
            : undefined,
        modelsDevId: editModalState.form.modelsDevId || undefined,
      });
    } catch (error) {
      console.error("Update failed:", error);
    }
  };

  const handleModelSelect = (
    model: NonNullable<typeof modelsDevModels>[number],
  ) => {
    const mappedProvider = PROVIDER_MAPPING[model.provider] || "openrouter";
    const modelIdToUse =
      mappedProvider === "openrouter"
        ? model.id
        : model.id.split("/").pop() || model.id;

    setEditModalState((prev) => ({
      ...prev,
      form: {
        ...prev.form,
        provider: mappedProvider,
        modelId: modelIdToUse,
        modelsDevId: model.id,
      },
    }));
    setModelSearch("");
  };

  // Add actions column to base columns
  const columnsWithActions = [
    ...columns,
    {
      id: "actions",
      header: "Actions",
      enableHiding: false,
      cell: ({ row }: { row: { original: ModelAliasRow } }) => (
        <ModelAliasActions
          alias={row.original}
          onEdit={() => {
            setEditModalState({
              open: true,
              selected: row.original,
              form: {
                alias: row.original.alias,
                provider: row.original.provider,
                modelId: row.original.modelId,
                modelsDevId: "",
              },
            });
            setModelSearch("");
            setProviderFilter("all");
          }}
        />
      ),
    },
  ];

  return (
    <div>
      <DataTable
        columns={columnsWithActions}
        data={(aliases as ModelAliasRow[]) || []}
        filterColumn="alias"
      />

      <Dialog
        open={editModalState.open}
        onOpenChange={(open) =>
          setEditModalState((prev) => ({ ...prev, open }))
        }
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Model Alias</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* Current capabilities display */}
            {editModalState.selected?.capabilities && (
              <div className="p-3 bg-muted/30 rounded-lg space-y-2">
                <div className="text-sm font-medium">Current Capabilities</div>
                <div className="flex items-center gap-2 flex-wrap">
                  {editModalState.selected.capabilities.inputModalities?.map(
                    (mod) => (
                      <Badge key={mod} variant="secondary" className="text-xs">
                        {mod === "image" && <Image className="w-3 h-3 mr-1" />}
                        {mod === "audio" && (
                          <AudioLines className="w-3 h-3 mr-1" />
                        )}
                        {mod === "video" && <Video className="w-3 h-3 mr-1" />}
                        {mod === "pdf" && <FileText className="w-3 h-3 mr-1" />}
                        {mod}
                      </Badge>
                    ),
                  )}
                  {editModalState.selected.capabilities.toolCall && (
                    <Badge variant="secondary" className="text-xs">
                      tool calling
                    </Badge>
                  )}
                  {editModalState.selected.capabilities.reasoning && (
                    <Badge variant="secondary" className="text-xs">
                      reasoning
                    </Badge>
                  )}
                </div>
                {editModalState.selected.capabilities.contextLength && (
                  <div className="text-xs text-muted-foreground">
                    Context:{" "}
                    {(
                      editModalState.selected.capabilities.contextLength / 1000
                    ).toFixed(1)}
                    k tokens
                    {!!editModalState.selected.capabilities.costInputPerMillion && (
                      <>
                        {" "}
                        • Cost: $
                        {editModalState.selected.capabilities.costInputPerMillion.toFixed(
                          2,
                        )}
                        /M input
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Search models */}
            <div className="space-y-3 p-4 border rounded-lg bg-muted/30">
              <div className="text-sm font-medium">Find a Different Model</div>
              <div className="flex gap-2">
                <Input
                  value={modelSearch}
                  onChange={(e) => setModelSearch(e.target.value)}
                  placeholder="Search models..."
                  className="flex-1"
                />
                <Select value={providerFilter} onValueChange={setProviderFilter}>
                  <SelectTrigger className="w-40">
                    <SelectValue placeholder="Provider" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Providers</SelectItem>
                    {providers?.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {isLoadingModels && (
                <div className="text-sm text-muted-foreground">Loading models...</div>
              )}

              {modelsDevModels && modelsDevModels.length > 0 && (
                <div className="max-h-48 overflow-y-auto space-y-1 border rounded p-2 bg-background">
                  {modelsDevModels.map((model) => (
                    <button
                      key={model.id}
                      type="button"
                      className="w-full text-left px-3 py-2 rounded hover:bg-accent transition-colors"
                      onClick={() => handleModelSelect(model)}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Badge
                            variant="outline"
                            className="text-[10px] px-1.5 py-0 font-normal"
                          >
                            {model.provider}
                          </Badge>
                          <span className="font-medium text-sm">
                            {model.name}
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          {model.supportsImage && (
                            <Image className="w-3 h-3 text-blue-500" />
                          )}
                          {model.supportsAudio && (
                            <AudioLines className="w-3 h-3 text-green-500" />
                          )}
                          {model.toolCall && (
                            <Badge
                              variant="secondary"
                              className="text-[10px] px-1"
                            >
                              tools
                            </Badge>
                          )}
                        </div>
                      </div>
                      <div className="text-[10px] text-muted-foreground mt-0.5 ml-12">
                        {model.id}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <Field>
              <Label>Alias</Label>
              <Input
                value={editModalState.form.alias}
                onChange={(e) =>
                  setEditModalState((prev) => ({
                    ...prev,
                    form: { ...prev.form, alias: e.target.value },
                  }))
                }
              />
            </Field>

            <Field>
              <Label>Provider</Label>
              <Select
                onValueChange={(v) => {
                  setEditModalState((prev) => ({
                    ...prev,
                    form: { ...prev.form, provider: v },
                  }));
                }}
                value={editModalState.form.provider}
              >
                <SelectTrigger className="w-56">
                  <SelectValue placeholder="Provider" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">openai</SelectItem>
                  <SelectItem value="openrouter">openrouter</SelectItem>
                  <SelectItem value="huggingface">huggingface</SelectItem>
                  <SelectItem value="cloudflare-workers-ai">cloudflare-workers-ai</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <Field>
              <Label>Model ID</Label>
              <Input
                value={editModalState.form.modelId}
                onChange={(e) =>
                  setEditModalState((prev) => ({
                    ...prev,
                    form: { ...prev.form, modelId: e.target.value },
                  }))
                }
                placeholder="e.g., gpt-4o or anthropic/claude-3-5-sonnet"
              />
            </Field>

            {editModalState.form.modelsDevId && (
              <div className="text-xs p-2 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-900 rounded">
                <span className="text-green-600 dark:text-green-400">
                  ✓ Model capabilities will be updated
                </span>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              onClick={handleEditSubmit}
              disabled={updateMutation.isPending}
            >
              {updateMutation.isPending ? "Updating..." : "Update"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default ModelAliasManagement;

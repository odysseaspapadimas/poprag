import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AudioLines, FileText, Image, Video } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

// Debounce hook for search input
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
}

interface CreateModelAliasFormProps {
  onSuccess?: () => void;
}

// Map models.dev provider to our internal provider type
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
  "huggingface-inference": "huggingface",
  "cloudflare-workers-ai": "cloudflare-workers-ai",
};

export function CreateModelAliasForm({ onSuccess }: CreateModelAliasFormProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [form, setForm] = useState({
    alias: "",
    provider: "openai" as
      | "openai"
      | "openrouter"
      | "huggingface"
      | "cloudflare-workers-ai",
    modelId: "",
    modelsDevId: "", // Full models.dev ID (e.g., "openai/gpt-4o")
    modelType: "chat" as "chat" | "embedding" | "reranker",
    embeddingDimensions: "",
  });
  const [modelSearch, setModelSearch] = useState("");
  const debouncedModelSearch = useDebounce(modelSearch, 300); // 300ms debounce
  const [providerFilter, setProviderFilter] = useState("all");
  const [modalityFilter, setModalityFilter] = useState<
    "all" | "image" | "audio" | "video" | "pdf"
  >("all");

  const createMutation = useMutation(
    trpc.model.create.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.model.list.queryKey() });
        toast.success("Model alias created");
        setForm({
          alias: "",
          provider: "openai",
          modelId: "",
          modelsDevId: "",
          modelType: "chat",
          embeddingDimensions: "",
        });
        setModelSearch("");
        setProviderFilter("all");
        setModalityFilter("all");
        onSuccess?.();
      },
      onError: (err) => {
        toast.error(`Failed to create alias: ${err.message}`);
      },
    }),
  );

  // Query for models from models.dev (uses debounced search)
  const { data: modelsDevModels, isLoading: isLoadingModels } = useQuery({
    ...trpc.model.searchModels.queryOptions({
      query: debouncedModelSearch || undefined,
      provider: providerFilter !== "all" ? providerFilter : undefined,
      hasImageInput: modalityFilter === "image" ? true : undefined,
      hasAudioInput: modalityFilter === "audio" ? true : undefined,
      hasVideoInput: modalityFilter === "video" ? true : undefined,
      hasPdfInput: modalityFilter === "pdf" ? true : undefined,
      excludeDeprecated: true,
      limit: 50,
    }),
    enabled: debouncedModelSearch.length > 0 || providerFilter !== "all",
  });

  // Query for available providers
  const { data: providers } = useQuery(trpc.model.listProviders.queryOptions());

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const dimensions = form.embeddingDimensions
      ? Number.parseInt(form.embeddingDimensions, 10)
      : undefined;

    await createMutation.mutateAsync({
      alias: form.alias,
      provider: form.provider,
      modelId: form.modelId,
      modelsDevId: form.modelsDevId || undefined,
      modelType: form.modelType,
      embeddingDimensions: dimensions,
    });
  };

  const handleModelSelect = (
    model: NonNullable<typeof modelsDevModels>[number],
  ) => {
    // Map the provider to our internal type
    const mappedProvider = PROVIDER_MAPPING[model.provider];

    // Determine the model ID to use based on provider:
    // - Cloudflare Workers AI: use the model name which contains the full path (e.g., "@cf/meta/llama-3.3-70b-instruct-fp8-fast")
    // - Others: use just the model part
    let modelIdToUse: string;
    if (mappedProvider === "cloudflare-workers-ai") {
      modelIdToUse = model.name; // Full name like "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
    } else {
      modelIdToUse = model.id; // Just the model id
    }

    setForm({
      alias: model.name.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
      provider: mappedProvider,
      modelId: modelIdToUse,
      modelsDevId: model.id,
      modelType: "chat", // Default to chat, user can change if needed
      embeddingDimensions: "",
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Search available models */}
      <div className="space-y-3 p-4 border rounded-lg bg-muted/30">
        <div className="text-sm font-medium">Find a Model</div>
        <div className="flex gap-2">
          <Input
            value={modelSearch}
            onChange={(e) => setModelSearch(e.target.value)}
            placeholder="Search models... (e.g., gpt-4, claude, llama)"
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
          <Select
            value={modalityFilter}
            onValueChange={(v) => setModalityFilter(v as typeof modalityFilter)}
          >
            <SelectTrigger className="w-36">
              <SelectValue placeholder="Modality" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="image">Image</SelectItem>
              <SelectItem value="audio">Audio</SelectItem>
              <SelectItem value="video">Video</SelectItem>
              <SelectItem value="pdf">PDF</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {(isLoadingModels ||
          (modelSearch !== debouncedModelSearch && modelSearch.length > 0)) && (
          <div className="text-sm text-muted-foreground">
            {modelSearch !== debouncedModelSearch
              ? "Typing..."
              : "Loading models..."}
          </div>
        )}

        {modelsDevModels && modelsDevModels.length > 0 && (
          <div className="max-h-64 overflow-y-auto space-y-1 border rounded p-2 bg-background">
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
                    <span className="font-medium text-sm">{model.name}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    {model.supportsImage && (
                      <Image className="w-3 h-3 text-blue-500" />
                    )}
                    {model.supportsAudio && (
                      <AudioLines className="w-3 h-3 text-green-500" />
                    )}
                    {model.supportsVideo && (
                      <Video className="w-3 h-3 text-purple-500" />
                    )}
                    {model.supportsPdf && (
                      <FileText className="w-3 h-3 text-orange-500" />
                    )}
                    {model.toolCall && (
                      <Badge variant="secondary" className="text-[10px] px-1">
                        tools
                      </Badge>
                    )}
                    {model.reasoning && (
                      <Badge variant="secondary" className="text-[10px] px-1">
                        reasoning
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="flex gap-2 mt-1 text-[10px] text-muted-foreground ml-12">
                  <span>{model.id}</span>
                  <span>•</span>
                  <span>
                    Context: {(model.contextLength / 1000).toFixed(0)}k
                  </span>
                  <span>•</span>
                  <span>
                    ${model.costInput.toFixed(2)}/${model.costOutput.toFixed(2)}{" "}
                    per M
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}

        {modelsDevModels &&
          modelsDevModels.length === 0 &&
          debouncedModelSearch && (
            <div className="text-sm text-muted-foreground">
              No models found matching "{debouncedModelSearch}"
            </div>
          )}
      </div>

      {/* Manual configuration fields */}
      <Field>
        <Label>Alias</Label>
        <Input
          value={form.alias}
          onChange={(e) =>
            setForm((prev) => ({ ...prev, alias: e.target.value }))
          }
          placeholder="e.g., gpt-4o-latest"
          required
        />
      </Field>

      <Field>
        <Label>Provider</Label>
        <Select
          onValueChange={(v) =>
            setForm((prev) => ({
              ...prev,
              provider: v as typeof form.provider,
            }))
          }
          value={form.provider}
        >
          <SelectTrigger className="w-56">
            <SelectValue placeholder="Provider" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="openai">openai</SelectItem>
            <SelectItem value="openrouter">openrouter</SelectItem>
            <SelectItem value="huggingface">huggingface</SelectItem>
            <SelectItem value="cloudflare-workers-ai">
              cloudflare-workers-ai
            </SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <Field>
        <Label>Model ID</Label>
        <Input
          value={form.modelId}
          onChange={(e) =>
            setForm((prev) => ({ ...prev, modelId: e.target.value }))
          }
          placeholder="e.g., gpt-4o or anthropic/claude-3-5-sonnet"
          required
        />
        <p className="text-xs text-muted-foreground mt-1">
          The model identifier used by the provider's API
        </p>
      </Field>

      <Field>
        <Label>Model Type</Label>
        <Select
          onValueChange={(v) =>
            setForm((prev) => ({
              ...prev,
              modelType: v as typeof form.modelType,
              // Clear dimensions if not embedding
              embeddingDimensions:
                v !== "embedding" ? "" : prev.embeddingDimensions,
            }))
          }
          value={form.modelType}
        >
          <SelectTrigger className="w-56">
            <SelectValue placeholder="Model Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="chat">chat</SelectItem>
            <SelectItem value="embedding">embedding</SelectItem>
            <SelectItem value="reranker">reranker</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      {form.modelType === "embedding" && (
        <Field>
          <Label>Embedding Dimensions</Label>
          <Input
            type="number"
            value={form.embeddingDimensions}
            onChange={(e) =>
              setForm((prev) => ({
                ...prev,
                embeddingDimensions: e.target.value,
              }))
            }
            placeholder="e.g., 1536, 1024, 768"
            required
          />
          <p className="text-xs text-muted-foreground mt-1">
            Required for embedding models. Common values: 1536 (OpenAI), 1024
            (Cohere), 768 (BERT-based)
          </p>
        </Field>
      )}

      {form.modelsDevId && (
        <div className="text-xs p-2 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-900 rounded space-y-1">
          <span className="text-green-600 dark:text-green-400">
            ✓ Model capabilities will be automatically configured
          </span>
          {modelsDevModels?.find((m) => m.id === form.modelsDevId) && (
            <div className="text-muted-foreground">
              Cost: $
              {modelsDevModels
                .find((m) => m.id === form.modelsDevId)
                ?.costInput.toFixed(2)}
              /M input, $
              {modelsDevModels
                .find((m) => m.id === form.modelsDevId)
                ?.costOutput.toFixed(2)}
              /M output
            </div>
          )}
        </div>
      )}

      <div className="flex justify-end">
        <Button type="submit" disabled={createMutation.isPending}>
          {createMutation.isPending ? "Creating..." : "Create"}
        </Button>
      </div>
    </form>
  );
}

export default CreateModelAliasForm;

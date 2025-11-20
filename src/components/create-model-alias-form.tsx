import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
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

interface CreateModelAliasFormProps {
  onSuccess?: () => void;
}

export function CreateModelAliasForm({ onSuccess }: CreateModelAliasFormProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [form, setForm] = useState({
    alias: "",
    provider: "openai",
    modelId: "",
  });
  const [modelSearch, setModelSearch] = useState("");
  const [showModelList, setShowModelList] = useState(false);

  const createMutation = useMutation(
    trpc.model.create.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.model.list.queryKey() });
        toast.success("Model alias created");
        setForm({ alias: "", provider: "openai", modelId: "" });
        setModelSearch("");
        setShowModelList(false);
        onSuccess?.();
      },
      onError: (err: any) => {
        toast.error(`Failed to create alias: ${err.message}`);
      },
    }),
  );

  // Query for provider models - using regular useQuery with enabled flag
  const { data: openaiModels } = useQuery({
    ...trpc.model.listOpenAIModels.queryOptions(),
    enabled: form.provider === "openai" && showModelList,
  });

  const { data: cloudflareModels } = useQuery({
    ...trpc.model.listCloudflareModels.queryOptions({ search: modelSearch }),
    enabled: form.provider === "workers-ai" && showModelList,
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await createMutation.mutateAsync({
      alias: form.alias,
      provider: form.provider as any,
      modelId: form.modelId,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Field>
        <Label>Alias</Label>
        <Input
          value={form.alias}
          onChange={(e) =>
            setForm((prev) => ({ ...prev, alias: e.target.value }))
          }
          required
        />
      </Field>
      <Field>
        <Label>Provider</Label>
        <Select
          onValueChange={(v) => {
            setForm((prev) => ({ ...prev, provider: v }));
            setModelSearch("");
            setShowModelList(false);
          }}
          value={form.provider}
        >
          <SelectTrigger className="w-56">
            <SelectValue placeholder="Provider" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="openai">openai</SelectItem>
            <SelectItem value="openrouter">openrouter</SelectItem>
            <SelectItem value="huggingface">huggingface</SelectItem>
            <SelectItem value="workers-ai">workers-ai</SelectItem>
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
          placeholder="e.g., gpt-4o or @cf/meta/llama-3.3-70b-instruct-fp8-fast"
          onFocus={() => {
            if (form.provider === "openai" || form.provider === "workers-ai") {
              setShowModelList(true);
            }
          }}
          onBlur={() => setTimeout(() => setShowModelList(false), 200)}
          required
        />
      </Field>
      {(form.provider === "openai" || form.provider === "workers-ai") && (
        <Field>
          <Label>Search Models</Label>
          <Input
            value={modelSearch}
            onChange={(e) => setModelSearch(e.target.value)}
            placeholder="Search models..."
            onFocus={() => setShowModelList(true)}
            onBlur={() => setTimeout(() => setShowModelList(false), 200)}
          />
        </Field>
      )}
      {showModelList && form.provider === "openai" && openaiModels && (
        <div className="p-3 border rounded max-h-48 overflow-y-auto">
          <div className="text-sm font-medium mb-2">OpenAI Models</div>
          <div className="space-y-1">
            {openaiModels
              .filter((model) =>
                model.name.toLowerCase().includes(modelSearch.toLowerCase()),
              )
              .map((model: any) => (
                <button
                  key={model.id}
                  type="button"
                  className="text-sm hover:bg-accent w-full text-left px-2 py-1 rounded"
                  onClick={() => {
                    setForm((prev) => ({ ...prev, modelId: model.id }));
                    setShowModelList(false);
                  }}
                >
                  {model.name}{" "}
                  <span className="text-muted-foreground">
                    ({model.ownedBy})
                  </span>
                </button>
              ))}
          </div>
        </div>
      )}
      {showModelList && form.provider === "workers-ai" && cloudflareModels && (
        <div className="p-3 border rounded max-h-48 overflow-y-auto">
          <div className="text-sm font-medium mb-2">
            Cloudflare Workers AI Models
          </div>
          <div className="space-y-1">
            {cloudflareModels.map((model: any) => (
              <button
                key={model.id}
                type="button"
                className="text-sm hover:bg-accent w-full text-left px-2 py-1 rounded"
                onClick={() => {
                  setForm((prev) => ({ ...prev, modelId: model.id }));
                  setShowModelList(false);
                }}
              >
                {model.name}{" "}
                <span className="text-muted-foreground">({model.task})</span>
              </button>
            ))}
          </div>
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

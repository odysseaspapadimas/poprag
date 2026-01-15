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
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

interface ModelPolicyEditorProps {
  agentId: string;
}

export function ModelPolicyEditor({ agentId }: ModelPolicyEditorProps) {
  const trpc = useTRPC();

  const { data: modelAliases } = useSuspenseQuery(
    trpc.model.list.queryOptions(),
  );
  const modelAliasesLoading = (modelAliases?.length ?? 0) === 0;

  const { data: policy } = useSuspenseQuery(
    trpc.agent.getModelPolicy.queryOptions({ agentId }),
  );

  const [formState, setFormState] = useState(() => ({
    modelAlias: policy?.modelAlias,
    temperature: policy?.temperature,
    topP: policy?.topP,
    maxTokens: policy?.maxTokens,
  }));

  useEffect(() => {
    if (policy) {
      setFormState((s) => ({
        ...s,
        modelAlias: policy.modelAlias ?? s.modelAlias,
        temperature: policy.temperature ?? s.temperature,
        topP: policy.topP ?? s.topP,
        maxTokens: policy.maxTokens ?? s.maxTokens,
      }));
    }
  }, [policy]);

  // If there is no selected model alias yet, default to the first available alias
  useEffect(() => {
    if (!formState.modelAlias && modelAliases && modelAliases.length > 0) {
      setFormState((s) => ({ ...s, modelAlias: modelAliases[0].alias }));
    }
  }, [modelAliases]);

  const queryClient = useQueryClient();
  const updatePolicy = useMutation(
    trpc.agent.updateModelPolicy.mutationOptions({
      onSuccess: () => {
        // Invalidate queries or refresh
        queryClient.invalidateQueries({
          queryKey: trpc.agent.getModelPolicy.queryKey({ agentId }),
        });
        toast.success("Model policy updated");
      },
      onError: (err: any) => {
        console.error("Failed to update model policy:", err);
        toast.error(`Failed to update model policy: ${err.message}`);
      },
    }),
  );

  const handleSave = async () => {
    await updatePolicy.mutateAsync({
      agentId,
      modelAlias: formState.modelAlias,
      temperature: Number(formState.temperature),
      topP: Number(formState.topP),
      maxTokens: formState.maxTokens ? Number(formState.maxTokens) : undefined,
    });
  };

  return (
    <div className="space-y-4">
      <Field>
        <Label>Model Alias</Label>
        <Select
          value={formState.modelAlias}
          onValueChange={(v) => setFormState({ ...formState, modelAlias: v })}
          disabled={!(modelAliases && modelAliases.length > 0)}
          aria-label="Model Alias"
        >
          <SelectTrigger className="w-56">
            <SelectValue placeholder="Select a model" />
          </SelectTrigger>
          <SelectContent>
            {modelAliasesLoading && (
              <SelectItem value="" disabled>
                Loading...
              </SelectItem>
            )}
            {modelAliases?.map((m: any) => (
              <SelectItem key={m.alias} value={m.alias}>
                {m.alias} ({m.provider})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field>
          <Label>Temperature</Label>
          <Input
            type="number"
            min={0}
            max={2}
            step={0.1}
            value={String(formState.temperature)}
            onChange={(e) =>
              setFormState({
                ...formState,
                temperature: Number(e.target.value),
              })
            }
          />
        </Field>

        <Field>
          <Label>Top P</Label>
          <Input
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={String(formState.topP)}
            onChange={(e) =>
              setFormState({ ...formState, topP: Number(e.target.value) })
            }
          />
        </Field>
      </div>

      <Field>
        <Label>Max Output Tokens</Label>
        <Input
          type="number"
          min={1}
          max={32000}
          step={1}
          placeholder="4096"
          value={formState.maxTokens ?? ''}
          onChange={(e) =>
            setFormState({ 
              ...formState, 
              maxTokens: e.target.value ? Number(e.target.value) : null 
            })
          }
        />
        <p className="text-sm text-muted-foreground mt-1">
          Maximum tokens for a single response. Default: 4096. Does not affect conversation context length.
        </p>
      </Field>

      <div className="flex gap-2">
        <Button onClick={handleSave} disabled={updatePolicy.isPending}>
          {updatePolicy.isPending ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}

export default ModelPolicyEditor;

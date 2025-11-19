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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useTRPC } from "@/integrations/trpc/react";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import ModelAliasActions from "./model-alias-actions";
import { columns } from "./tables/columns-models";
import { DataTable } from "./tables/data-table";

interface EditModalState {
  open: boolean;
  selected: any;
  form: { alias: string; provider: string; modelId: string };
}

export function ModelAliasManagement() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data: aliases } = useSuspenseQuery(trpc.model.list.queryOptions());

  const [editModalState, setEditModalState] = useState<EditModalState>({
    open: false,
    selected: null,
    form: { alias: "", provider: "", modelId: "" }
  });

  const updateMutation = useMutation(trpc.model.update.mutationOptions({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.model.list.queryKey() });
      toast.success("Model alias updated");
      setEditModalState(prev => ({ ...prev, open: false }));
    },
    onError: (err: any) => {
      toast.error(`Failed to update alias: ${err.message}`);
    },
  }));

  const [modelSearch, setModelSearch] = useState("");
  const [showModelList, setShowModelList] = useState(false);

  // Query for provider models - using regular useQuery with enabled flag
  const { data: openaiModels } = useQuery({
    ...trpc.model.listOpenAIModels.queryOptions(),
    enabled: editModalState.form.provider === "openai" && showModelList,
  });

  const { data: cloudflareModels } = useQuery({
    ...trpc.model.listCloudflareModels.queryOptions({search: modelSearch}),
    enabled: editModalState.form.provider === "workers-ai" && showModelList,
  });

  const handleEditSubmit = async () => {
    await updateMutation.mutateAsync({
      alias: editModalState.selected.alias,
      newAlias: editModalState.form.alias !== editModalState.selected.alias ? editModalState.form.alias : undefined,
      provider: editModalState.form.provider !== editModalState.selected.provider ? (editModalState.form.provider as any) : undefined,
      modelId: editModalState.form.modelId !== editModalState.selected.modelId ? editModalState.form.modelId : undefined,
    });
  };

  return (
    <div>
      <DataTable
        columns={[
          ...columns,
          {
            id: "actions",
            header: "Actions",
            enableHiding: false,
            cell: ({ row }) => (
              <ModelAliasActions
                alias={row.original}
                onEdit={() => {
                  setEditModalState({
                    open: true,
                    selected: row.original,
                    form: { alias: row.original.alias, provider: row.original.provider, modelId: row.original.modelId }
                  });
                  setModelSearch("");
                  setShowModelList(false);
                }}
              />
            ),
          },
        ]}
        data={aliases || []}
      />

      <Dialog open={editModalState.open} onOpenChange={(open) => setEditModalState(prev => ({ ...prev, open }))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Model Alias</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <Field>
              <Label>Alias</Label>
              <Input value={editModalState.form.alias} onChange={(e) => setEditModalState(prev => ({ ...prev, form: { ...prev.form, alias: e.target.value } }))} />
            </Field>
            <Field>
              <Label>Provider</Label>
              <Select onValueChange={(v) => {
                setEditModalState(prev => ({ ...prev, form: { ...prev.form, provider: v } }));
                setModelSearch("");
                setShowModelList(false);
              }} value={editModalState.form.provider}>
                <SelectTrigger className="w-56"><SelectValue placeholder="Provider" /></SelectTrigger>
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
                value={editModalState.form.modelId} 
                onChange={(e) => setEditModalState(prev => ({ ...prev, form: { ...prev.form, modelId: e.target.value } }))} 
                placeholder="e.g., gpt-4o or @cf/meta/llama-3.3-70b-instruct-fp8-fast"
                onFocus={() => {
                  if (editModalState.form.provider === "openai" || editModalState.form.provider === "workers-ai") {
                    setShowModelList(true);
                  }
                }}
                onBlur={() => setTimeout(() => setShowModelList(false), 200)}
              />
            </Field>
            {(editModalState.form.provider === "openai" || editModalState.form.provider === "workers-ai") && (
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
            {showModelList && editModalState.form.provider === "openai" && openaiModels && (
              <div className="p-3 border rounded max-h-48 overflow-y-auto">
                <div className="text-sm font-medium mb-2">OpenAI Models</div>
                <div className="space-y-1">
                  {openaiModels.filter(model => model.name.toLowerCase().includes(modelSearch.toLowerCase())).map((model: any) => (
                    <button
                      key={model.id}
                      type="button"
                      className="text-sm hover:bg-accent w-full text-left px-2 py-1 rounded"
                      onClick={() => {
                        setEditModalState(prev => ({ ...prev, form: { ...prev.form, modelId: model.id } }));
                        setShowModelList(false);
                      }}
                    >
                      {model.name} <span className="text-muted-foreground">({model.ownedBy})</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {showModelList && editModalState.form.provider === "workers-ai" && cloudflareModels && (
              <div className="p-3 border rounded max-h-48 overflow-y-auto">
                <div className="text-sm font-medium mb-2">Cloudflare Workers AI Models</div>
                <div className="space-y-1">
                  {cloudflareModels.map((model: any) => (
                    <button
                      key={model.id}
                      type="button"
                      className="text-sm hover:bg-accent w-full text-left px-2 py-1 rounded"
                      onClick={() => {
                        setEditModalState(prev => ({ ...prev, form: { ...prev.form, modelId: model.id } }));
                        setShowModelList(false);
                      }}
                    >
                      {model.name} <span className="text-muted-foreground">({model.task})</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button onClick={handleEditSubmit} disabled={updateMutation.isPending}>{updateMutation.isPending ? 'Updating...' : 'Update'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default ModelAliasManagement;

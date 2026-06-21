import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DatabaseZap, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useTRPC } from "@/integrations/trpc/react";

type CatalogConfigFormValue = {
  name: string;
  experienceId: string;
  snapshotUrl: string;
  diffUrl: string;
  authHeaderName: string;
  authSecretName: string;
  updatedSinceParam: string;
  itemPath: string;
  stableKeyField: string;
  updatedAtField: string;
  deletionField: string;
  deletionInactiveValues: string;
  titleField: string;
  searchableFields: string;
  exactMatchFields: string;
  filterableFields: string;
  syncIntervalDays: number;
  scheduleWeekdayUtc: number;
  scheduleHourUtc: number;
  enabled: boolean;
};

type CatalogSyncDialogConfig = {
  id: string;
  name: string;
  experienceId: string | null;
  snapshotUrl: string;
  diffUrl: string;
  authHeaderName: string | null;
  authSecretName: string | null;
  updatedSinceParam: string;
  itemPath: string;
  stableKeyField: string;
  updatedAtField: string | null;
  deletionField: string | null;
  deletionInactiveValues: string[] | null;
  titleField: string;
  searchableFields: string[] | null;
  exactMatchFields: string[] | null;
  filterableFields: string[] | null;
  syncIntervalDays: number;
  scheduleWeekdayUtc: number;
  scheduleHourUtc: number;
  enabled: boolean;
};

interface CatalogSyncDialogProps {
  agentId: string;
  config?: CatalogSyncDialogConfig;
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const NO_EXPERIENCE_VALUE = "__none__";
const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
const DEFAULT_UPDATED_SINCE_PARAM = "effectiveUpdatedAfter";

function emptyForm(): CatalogConfigFormValue {
  return {
    name: "",
    experienceId: NO_EXPERIENCE_VALUE,
    snapshotUrl: "",
    diffUrl: "",
    authHeaderName: "Authorization",
    authSecretName: "",
    updatedSinceParam: DEFAULT_UPDATED_SINCE_PARAM,
    itemPath: "results",
    stableKeyField: "contentId",
    updatedAtField: "effectiveUpdatedAt",
    deletionField: "productStatus",
    deletionInactiveValues: "inactive, deleted, archived, false, 0, no",
    titleField: "document.general-information.name.el-GR",
    searchableFields: [
      "document.general-information.name.el-GR",
      "document.general-information.name.en-GB",
      "document.general-information.description.el-GR",
      "document.general-information.description.en-GB",
      "document.general-information.usageInstructions.el-GR",
      "document.general-information.competitionAdvantage.el-GR",
      "document.main.productingredients.el-GR",
      "document.main.specialwarningsandprecautionsforuse.el-GR",
      "document.relations.keywords.el-GR",
      "parent.documentSummary.name.el-GR",
      "category",
    ].join(", "),
    exactMatchFields: [
      "contentId",
      "code",
      "document.identity-codes.supplierSKU",
      "document.gs1-and-barcode.gtin",
      "document.box-description.boxBarcode",
      "document.general-information.name.el-GR",
      "document.general-information.name.en-GB",
    ].join(", "),
    filterableFields: ["parent.documentSummary.name.el-GR", "category"].join(
      ", ",
    ),
    syncIntervalDays: 7,
    scheduleWeekdayUtc: 1,
    scheduleHourUtc: 3,
    enabled: true,
  };
}

function formFromConfig(
  config?: CatalogSyncDialogConfig,
): CatalogConfigFormValue {
  if (!config) return emptyForm();

  return {
    name: config.name,
    experienceId: config.experienceId ?? NO_EXPERIENCE_VALUE,
    snapshotUrl: config.snapshotUrl,
    diffUrl: config.diffUrl === config.snapshotUrl ? "" : config.diffUrl,
    authHeaderName: config.authHeaderName ?? "Authorization",
    authSecretName: config.authSecretName ?? "",
    updatedSinceParam: config.updatedSinceParam || DEFAULT_UPDATED_SINCE_PARAM,
    itemPath: config.itemPath,
    stableKeyField: config.stableKeyField,
    updatedAtField: config.updatedAtField ?? "",
    deletionField: config.deletionField ?? "",
    deletionInactiveValues: (config.deletionInactiveValues ?? []).join(", "),
    titleField: config.titleField,
    searchableFields: (config.searchableFields ?? []).join(", "),
    exactMatchFields: (config.exactMatchFields ?? []).join(", "),
    filterableFields: (config.filterableFields ?? []).join(", "),
    syncIntervalDays: config.syncIntervalDays,
    scheduleWeekdayUtc: config.scheduleWeekdayUtc,
    scheduleHourUtc: config.scheduleHourUtc,
    enabled: config.enabled,
  };
}

function parseList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function CatalogSyncDialog({
  agentId,
  config,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: CatalogSyncDialogProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;
  const [form, setForm] = useState<CatalogConfigFormValue>(() =>
    formFromConfig(config),
  );

  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const isEditing = Boolean(config);

  const { data: experiences = [] } = useQuery(
    trpc.experience.list.queryOptions(
      { agentId },
      {
        enabled: open,
      },
    ),
  );

  useEffect(() => {
    if (open) {
      setForm(formFromConfig(config));
    }
  }, [config, open]);

  const createMutation = useMutation(
    trpc.catalogSync.create.mutationOptions({
      onSuccess: () => {
        toast.success("Catalog sync created");
        setOpen(false);
        queryClient.invalidateQueries({
          queryKey: trpc.catalogSync.list.queryKey({ agentId }),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.catalog.list.queryKey({ agentId }),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.agent.getKnowledgeSources.queryKey({ agentId }),
        });
      },
      onError: (error) => {
        toast.error(`Catalog sync setup failed: ${error.message}`);
      },
    }),
  );

  const updateMutation = useMutation(
    trpc.catalogSync.update.mutationOptions({
      onSuccess: () => {
        toast.success("Catalog sync updated");
        setOpen(false);
        queryClient.invalidateQueries({
          queryKey: trpc.catalogSync.list.queryKey({ agentId }),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.catalog.list.queryKey({ agentId }),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.agent.getKnowledgeSources.queryKey({ agentId }),
        });
      },
      onError: (error) => {
        toast.error(`Catalog sync update failed: ${error.message}`);
      },
    }),
  );

  const payload = useMemo(
    () => ({
      name: form.name.trim(),
      experienceId:
        form.experienceId === NO_EXPERIENCE_VALUE ? null : form.experienceId,
      snapshotUrl: form.snapshotUrl.trim(),
      diffUrl: form.diffUrl.trim(),
      authHeaderName: form.authHeaderName.trim() || null,
      authSecretName: form.authSecretName.trim() || null,
      updatedSinceParam:
        form.updatedSinceParam.trim() || DEFAULT_UPDATED_SINCE_PARAM,
      itemPath: form.itemPath.trim(),
      stableKeyField: form.stableKeyField.trim(),
      updatedAtField: form.updatedAtField.trim() || null,
      deletionField: form.deletionField.trim() || null,
      deletionInactiveValues: parseList(form.deletionInactiveValues),
      titleField: form.titleField.trim(),
      searchableFields: parseList(form.searchableFields),
      exactMatchFields: parseList(form.exactMatchFields),
      filterableFields: parseList(form.filterableFields),
      syncIntervalDays: form.syncIntervalDays,
      scheduleWeekdayUtc: form.scheduleWeekdayUtc,
      scheduleHourUtc: form.scheduleHourUtc,
      enabled: form.enabled,
    }),
    [form],
  );

  const isPending = createMutation.isPending || updateMutation.isPending;

  const submit = () => {
    if (isEditing && config) {
      updateMutation.mutate({ configId: config.id, ...payload });
    } else {
      createMutation.mutate({ agentId, ...payload });
    }
  };

  const updateField = <K extends keyof CatalogConfigFormValue>(
    key: K,
    value: CatalogConfigFormValue[K],
  ) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? "Edit Catalog Sync" : "Add Catalog Sync"}
          </DialogTitle>
          <DialogDescription>
            Configure a product catalog API source and map its product fields.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 py-2">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="catalog-name">Name</Label>
              <Input
                id="catalog-name"
                value={form.name}
                onChange={(event) => updateField("name", event.target.value)}
                placeholder="Retail product catalog"
              />
            </div>
            <div className="space-y-2">
              <Label>Experience</Label>
              <Select
                value={form.experienceId}
                onValueChange={(value) => updateField("experienceId", value)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="No experience" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_EXPERIENCE_VALUE}>
                    No experience
                  </SelectItem>
                  {experiences.map((experience) => (
                    <SelectItem key={experience.id} value={experience.id}>
                      {experience.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4">
            <div className="space-y-2">
              <Label htmlFor="snapshot-url">Full snapshot URL</Label>
              <Input
                id="snapshot-url"
                value={form.snapshotUrl}
                onChange={(event) =>
                  updateField("snapshotUrl", event.target.value)
                }
                placeholder="https://api.example.com/products"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="diff-url">Diff URL</Label>
              <Input
                id="diff-url"
                value={form.diffUrl}
                onChange={(event) => updateField("diffUrl", event.target.value)}
                placeholder="Leave blank to use snapshot URL"
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="auth-header">Auth header</Label>
              <Input
                id="auth-header"
                value={form.authHeaderName}
                onChange={(event) =>
                  updateField("authHeaderName", event.target.value)
                }
                placeholder="Authorization"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="auth-secret">Secret name</Label>
              <Input
                id="auth-secret"
                value={form.authSecretName}
                onChange={(event) =>
                  updateField("authSecretName", event.target.value)
                }
                placeholder="PRODUCT_CATALOG_TOKEN"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="since-param">Since param</Label>
              <Input
                id="since-param"
                value={form.updatedSinceParam}
                onChange={(event) =>
                  updateField("updatedSinceParam", event.target.value)
                }
                placeholder="effectiveUpdatedAfter"
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="item-path">Item path</Label>
              <Input
                id="item-path"
                value={form.itemPath}
                onChange={(event) =>
                  updateField("itemPath", event.target.value)
                }
                placeholder="data.products"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="stable-key">Stable key field</Label>
              <Input
                id="stable-key"
                value={form.stableKeyField}
                onChange={(event) =>
                  updateField("stableKeyField", event.target.value)
                }
                placeholder="sku"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="title-field">Title field</Label>
              <Input
                id="title-field"
                value={form.titleField}
                onChange={(event) =>
                  updateField("titleField", event.target.value)
                }
                placeholder="name"
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="updated-at-field">Updated-at field</Label>
              <Input
                id="updated-at-field"
                value={form.updatedAtField}
                onChange={(event) =>
                  updateField("updatedAtField", event.target.value)
                }
                placeholder="updated_at"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="deletion-field">Deletion/status field</Label>
              <Input
                id="deletion-field"
                value={form.deletionField}
                onChange={(event) =>
                  updateField("deletionField", event.target.value)
                }
                placeholder="status"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="inactive-values">Inactive values</Label>
              <Input
                id="inactive-values"
                value={form.deletionInactiveValues}
                onChange={(event) =>
                  updateField("deletionInactiveValues", event.target.value)
                }
                placeholder="inactive, deleted"
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="searchable-fields">Searchable fields</Label>
              <Textarea
                id="searchable-fields"
                value={form.searchableFields}
                onChange={(event) =>
                  updateField("searchableFields", event.target.value)
                }
                placeholder="name, description, ingredients"
                rows={3}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="exact-fields">Exact match fields</Label>
              <Textarea
                id="exact-fields"
                value={form.exactMatchFields}
                onChange={(event) =>
                  updateField("exactMatchFields", event.target.value)
                }
                placeholder="sku, barcode, name"
                rows={3}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="filterable-fields">Filterable fields</Label>
            <Textarea
              id="filterable-fields"
              value={form.filterableFields}
              onChange={(event) =>
                updateField("filterableFields", event.target.value)
              }
              placeholder="brand, category, productType"
              rows={2}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="interval-days">Interval days</Label>
              <Input
                id="interval-days"
                type="number"
                min={1}
                max={31}
                value={form.syncIntervalDays}
                onChange={(event) =>
                  updateField(
                    "syncIntervalDays",
                    Number(event.target.value) || 7,
                  )
                }
              />
            </div>
            <div className="space-y-2">
              <Label>Weekday UTC</Label>
              <Select
                value={String(form.scheduleWeekdayUtc)}
                onValueChange={(value) =>
                  updateField("scheduleWeekdayUtc", Number(value))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WEEKDAYS.map((day, index) => (
                    <SelectItem key={day} value={String(index)}>
                      {day}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="hour-utc">Hour UTC</Label>
              <Input
                id="hour-utc"
                type="number"
                min={0}
                max={23}
                value={form.scheduleHourUtc}
                onChange={(event) =>
                  updateField(
                    "scheduleHourUtc",
                    Number(event.target.value) || 0,
                  )
                }
              />
            </div>
          </div>

          <div className="flex items-center gap-2 text-sm">
            <Checkbox
              id="catalog-enabled"
              checked={form.enabled}
              onCheckedChange={(checked) =>
                updateField("enabled", checked === true)
              }
            />
            <Label htmlFor="catalog-enabled">Enabled</Label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={isPending}>
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <DatabaseZap className="h-4 w-4" />
            )}
            {isEditing ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

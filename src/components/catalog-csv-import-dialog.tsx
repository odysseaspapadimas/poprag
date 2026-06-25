import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DatabaseZap, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

interface CatalogCsvImportDialogProps {
  agentId: string;
  trigger?: ReactNode;
}

type CsvCatalogForm = {
  name: string;
  scopeName: string;
  scopeAliases: string;
  experienceId: string;
  stableKeyField: string;
  titleField: string;
  updatedAtField: string;
  deletionField: string;
  deletionInactiveValues: string;
  searchableFields: string;
  exactMatchFields: string;
  filterableFields: string;
};

const NO_EXPERIENCE_VALUE = "__none__";

function emptyForm(): CsvCatalogForm {
  return {
    name: "",
    scopeName: "",
    scopeAliases: "",
    experienceId: NO_EXPERIENCE_VALUE,
    stableKeyField: "",
    titleField: "",
    updatedAtField: "",
    deletionField: "",
    deletionInactiveValues: "inactive, deleted, archived, false, 0, no",
    searchableFields: "",
    exactMatchFields: "",
    filterableFields: "",
  };
}

function parseList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function CatalogCsvImportDialog({
  agentId,
  trigger,
}: CatalogCsvImportDialogProps) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileText, setFileText] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [form, setForm] = useState<CsvCatalogForm>(() => emptyForm());

  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data: experiences = [] } = useQuery(
    trpc.experience.list.queryOptions(
      { agentId },
      {
        enabled: open,
      },
    ),
  );

  const uploadStart = useMutation(
    trpc.catalog.csvUploadStart.mutationOptions(),
  );
  const confirm = useMutation(trpc.catalog.csvConfirm.mutationOptions());
  const index = useMutation(trpc.catalog.csvIndex.mutationOptions());
  const isPending =
    uploadStart.isPending || confirm.isPending || index.isPending;

  const payload = useMemo(
    () => ({
      name: form.name.trim(),
      scopeName: form.scopeName.trim() || null,
      scopeAliases: parseList(form.scopeAliases),
      experienceId:
        form.experienceId === NO_EXPERIENCE_VALUE ? null : form.experienceId,
      stableKeyField: form.stableKeyField.trim(),
      titleField: form.titleField.trim(),
      updatedAtField: form.updatedAtField.trim() || null,
      deletionField: form.deletionField.trim() || null,
      deletionInactiveValues: parseList(form.deletionInactiveValues),
      searchableFields: parseList(form.searchableFields),
      exactMatchFields: parseList(form.exactMatchFields),
      filterableFields: parseList(form.filterableFields),
      enabled: true,
    }),
    [form],
  );

  const updateField = <K extends keyof CsvCatalogForm>(
    key: K,
    value: CsvCatalogForm[K],
  ) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const handleFile = async (nextFile: File | undefined) => {
    if (!nextFile) return;
    setFile(nextFile);
    const text = await nextFile.text();
    setFileText(text);
    const detectedHeaders = parseHeaderRow(text, nextFile.name);
    setHeaders(detectedHeaders);

    const guessedTitle =
      findHeader(detectedHeaders, ["name", "title", "product"]) ??
      detectedHeaders[0] ??
      "";
    const guessedKey =
      findHeader(detectedHeaders, ["sku", "barcode", "gtin", "id", "code"]) ??
      detectedHeaders[0] ??
      "";
    const guessedFilterable = detectedHeaders.filter((header) =>
      /brand|category|type|line|family|segment/i.test(header),
    );
    const guessedExact = detectedHeaders.filter((header) =>
      /sku|barcode|gtin|ean|upc|id|code/i.test(header),
    );

    setForm((current) => ({
      ...current,
      name: current.name || nextFile.name.replace(/\.[^.]+$/, ""),
      stableKeyField: current.stableKeyField || guessedKey,
      titleField: current.titleField || guessedTitle,
      searchableFields:
        current.searchableFields ||
        detectedHeaders
          .slice(0, Math.min(8, detectedHeaders.length))
          .join(", "),
      exactMatchFields: current.exactMatchFields || guessedExact.join(", "),
      filterableFields:
        current.filterableFields || guessedFilterable.join(", "),
    }));
  };

  const submit = async () => {
    if (!file) {
      toast.error("Choose a CSV file first");
      return;
    }
    if (!payload.name || !payload.stableKeyField || !payload.titleField) {
      toast.error("Name, stable key, and title field are required");
      return;
    }

    try {
      toast.loading(`Importing ${file.name}...`, {
        id: `catalog-csv-${file.name}`,
      });
      const upload = await uploadStart.mutateAsync({
        agentId,
        fileName: file.name,
        mime: file.type || "text/csv",
        bytes: file.size,
        ...payload,
      });

      const response = await fetch(upload.uploadUrl, {
        method: "PUT",
        body: file,
      });
      if (!response.ok) {
        throw new Error(`Upload failed: ${response.statusText}`);
      }

      const checksum = await sha256Hex(await file.arrayBuffer());
      await confirm.mutateAsync({ sourceId: upload.sourceId, checksum });
      const inlineContent = file.size < 1024 * 1024 ? fileText : undefined;
      await index.mutateAsync({
        sourceId: upload.sourceId,
        content: inlineContent,
      });

      toast.success(`Imported ${file.name} as a product catalog`, {
        id: `catalog-csv-${file.name}`,
      });
      setOpen(false);
      setFile(null);
      setFileText("");
      setHeaders([]);
      setForm(emptyForm());
      queryClient.invalidateQueries({
        queryKey: trpc.catalog.list.queryKey({ agentId }),
      });
      queryClient.invalidateQueries({
        queryKey: trpc.agent.getKnowledgeSources.queryKey({ agentId }),
      });
    } catch (error) {
      toast.error(
        `CSV catalog import failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { id: `catalog-csv-${file.name}` },
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import Catalog CSV</DialogTitle>
          <DialogDescription>
            Create a product catalog from a CSV or TSV source.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 py-2">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="catalog-csv-file">CSV file</Label>
              <Input
                id="catalog-csv-file"
                type="file"
                accept=".csv,.tsv,text/csv,text/tab-separated-values"
                onChange={(event) => void handleFile(event.target.files?.[0])}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="catalog-csv-name">Name</Label>
              <Input
                id="catalog-csv-name"
                value={form.name}
                onChange={(event) => updateField("name", event.target.value)}
                placeholder="Retail product catalog"
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="catalog-csv-scope-name">Catalog owner</Label>
              <Input
                id="catalog-csv-scope-name"
                value={form.scopeName}
                onChange={(event) =>
                  updateField("scopeName", event.target.value)
                }
                placeholder="Nestlé, ACME, ExampleCo..."
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="catalog-csv-scope-aliases">Owner aliases</Label>
              <Textarea
                id="catalog-csv-scope-aliases"
                value={form.scopeAliases}
                onChange={(event) =>
                  updateField("scopeAliases", event.target.value)
                }
                placeholder="ACME Foods, ExampleCo Greece"
                rows={2}
              />
            </div>
          </div>

          {headers.length > 0 ? (
            <div className="space-y-2">
              <Label>Detected headers</Label>
              <div className="flex max-h-24 flex-wrap gap-2 overflow-y-auto rounded border p-2">
                {headers.map((header) => (
                  <Badge key={header} variant="outline">
                    {header}
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-3">
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
            <div className="space-y-2">
              <Label htmlFor="catalog-csv-key">Stable key field</Label>
              <Input
                id="catalog-csv-key"
                value={form.stableKeyField}
                onChange={(event) =>
                  updateField("stableKeyField", event.target.value)
                }
                placeholder="sku"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="catalog-csv-title">Title field</Label>
              <Input
                id="catalog-csv-title"
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
              <Label htmlFor="catalog-csv-updated">Updated-at field</Label>
              <Input
                id="catalog-csv-updated"
                value={form.updatedAtField}
                onChange={(event) =>
                  updateField("updatedAtField", event.target.value)
                }
                placeholder="updated_at"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="catalog-csv-status">Deletion/status field</Label>
              <Input
                id="catalog-csv-status"
                value={form.deletionField}
                onChange={(event) =>
                  updateField("deletionField", event.target.value)
                }
                placeholder="status"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="catalog-csv-inactive">Inactive values</Label>
              <Input
                id="catalog-csv-inactive"
                value={form.deletionInactiveValues}
                onChange={(event) =>
                  updateField("deletionInactiveValues", event.target.value)
                }
                placeholder="inactive, deleted"
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="catalog-csv-searchable">Searchable fields</Label>
              <Textarea
                id="catalog-csv-searchable"
                value={form.searchableFields}
                onChange={(event) =>
                  updateField("searchableFields", event.target.value)
                }
                placeholder="name, description"
                rows={3}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="catalog-csv-exact">Exact fields</Label>
              <Textarea
                id="catalog-csv-exact"
                value={form.exactMatchFields}
                onChange={(event) =>
                  updateField("exactMatchFields", event.target.value)
                }
                placeholder="sku, barcode"
                rows={3}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="catalog-csv-filterable">Filterable fields</Label>
              <Textarea
                id="catalog-csv-filterable"
                value={form.filterableFields}
                onChange={(event) =>
                  updateField("filterableFields", event.target.value)
                }
                placeholder="brand, category"
                rows={3}
              />
            </div>
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
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function parseHeaderRow(text: string, fileName: string): string[] {
  const delimiter = fileName.toLowerCase().endsWith(".tsv") ? "\t" : ",";
  const [headerRow] = parseDelimitedRows(text, delimiter);
  return (headerRow ?? [])
    .map((header, index) => header.trim() || `Column ${index + 1}`)
    .filter(Boolean);
}

function findHeader(headers: string[], candidates: string[]) {
  return headers.find((header) =>
    candidates.some((candidate) =>
      header.toLocaleLowerCase().includes(candidate),
    ),
  );
}

function parseDelimitedRows(input: string, delimiter: "," | "\t"): string[][] {
  const rows: string[][] = [];
  const row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const nextChar = input[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      row.push(field);
      field = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && nextChar === "\n") i += 1;
      row.push(field);
      rows.push(row);
      return rows;
    }

    field += char;
  }

  row.push(field);
  rows.push(row);
  return rows;
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

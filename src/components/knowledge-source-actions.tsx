import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DatabaseZap,
  History,
  Loader2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CatalogSyncDialog } from "@/components/catalog-sync-dialog";
import { CatalogSyncRunsDialog } from "@/components/catalog-sync-runs-dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { KnowledgeSource } from "@/db/schema";
import { useTRPC } from "@/integrations/trpc/react";

interface KnowledgeSourceActionsProps {
  source: KnowledgeSource;
  agentId: string;
  catalogConfig?: {
    id: string;
    origin: "api" | "csv";
    syncConfigId?: string | null;
    name: string;
    scopeName?: string | null;
    scopeAliases?: string[] | null;
    experienceId: string | null;
    snapshotUrl?: string | null;
    diffUrl?: string | null;
    authHeaderName?: string | null;
    authSecretName?: string | null;
    updatedSinceParam?: string | null;
    itemPath?: string | null;
    stableKeyField: string;
    updatedAtField: string | null;
    deletionField: string | null;
    deletionInactiveValues: string[] | null;
    titleField: string;
    searchableFields: string[] | null;
    exactMatchFields: string[] | null;
    filterableFields: string[] | null;
    syncIntervalDays?: number | null;
    scheduleWeekdayUtc?: number | null;
    scheduleHourUtc?: number | null;
    enabled: boolean;
  };
}

export function KnowledgeSourceActions({
  source,
  agentId,
  catalogConfig,
}: KnowledgeSourceActionsProps) {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editCatalogOpen, setEditCatalogOpen] = useState(false);
  const [runsOpen, setRunsOpen] = useState(false);

  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // Mutations
  const reindexMutation = useMutation(
    trpc.knowledge.reindex.mutationOptions({
      onMutate: () => {
        // Show persistent toast during re-indexing
        toast.loading(`Queueing re-index for ${source.fileName}...`, {
          id: `reindex-${source.id}`,
          description:
            "Progress will appear live in the list once the worker starts.",
        });
      },
      onSuccess: () => {
        toast.success(`Re-index queued for ${source.fileName}`, {
          id: `reindex-${source.id}`,
          description:
            "Watch the source row for progress, retries, and any failure details.",
        });
        queryClient.invalidateQueries({
          queryKey: trpc.agent.getKnowledgeSources.queryKey({ agentId }),
        });
      },
      onError: (error) => {
        toast.error(`Re-indexing failed: ${error.message}`, {
          id: `reindex-${source.id}`,
        });
      },
    }),
  );

  const deleteMutation = useMutation(
    trpc.knowledge.delete.mutationOptions({
      onSuccess: () => {
        toast.success("Knowledge source deleted successfully");
        queryClient.invalidateQueries({
          queryKey: trpc.agent.getKnowledgeSources.queryKey({ agentId }),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.catalog.list.queryKey({ agentId }),
        });
        setDeleteDialogOpen(false);
      },
      onError: (error) => {
        toast.error(`Deletion failed: ${error.message}`);
      },
    }),
  );

  const runCatalogSyncMutation = useMutation(
    trpc.catalogSync.run.mutationOptions({
      onMutate: () => {
        toast.loading(`Queueing catalog sync for ${source.fileName}...`, {
          id: `catalog-sync-${source.id}`,
        });
      },
      onSuccess: () => {
        toast.success(`Catalog sync queued for ${source.fileName}`, {
          id: `catalog-sync-${source.id}`,
        });
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
        toast.error(`Catalog sync failed to queue: ${error.message}`, {
          id: `catalog-sync-${source.id}`,
        });
      },
    }),
  );

  const reimportCsvCatalogMutation = useMutation(
    trpc.catalog.csvReimport.mutationOptions({
      onMutate: () => {
        toast.loading(`Re-importing CSV catalog for ${source.fileName}...`, {
          id: `catalog-csv-${source.id}`,
        });
      },
      onSuccess: () => {
        toast.success(`CSV catalog re-imported for ${source.fileName}`, {
          id: `catalog-csv-${source.id}`,
        });
        queryClient.invalidateQueries({
          queryKey: trpc.catalog.list.queryKey({ agentId }),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.agent.getKnowledgeSources.queryKey({ agentId }),
        });
      },
      onError: (error) => {
        toast.error(`CSV catalog re-import failed: ${error.message}`, {
          id: `catalog-csv-${source.id}`,
        });
      },
    }),
  );

  const handleReindex = () => {
    reindexMutation.mutate({
      sourceId: source.id,
    });
  };

  const handleDelete = () => {
    deleteMutation.mutate({
      sourceId: source.id,
    });
  };

  const handleRunCatalogSync = () => {
    if (!catalogConfig?.syncConfigId) return;
    runCatalogSyncMutation.mutate({
      configId: catalogConfig.syncConfigId,
      mode: "auto",
    });
  };

  const handleReimportCsvCatalog = () => {
    reimportCsvCatalogMutation.mutate({
      sourceId: source.id,
    });
  };

  const isReindexing =
    reindexMutation.isPending ||
    runCatalogSyncMutation.isPending ||
    reimportCsvCatalogMutation.isPending;
  const isApiCatalog = catalogConfig?.origin === "api";
  const isCsvCatalog = catalogConfig?.origin === "csv";

  return (
    <>
      {isReindexing ? (
        <Button variant="outline" size="sm" disabled>
          <Loader2 className="h-4 w-4 animate-spin" />
        </Button>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Actions</DropdownMenuLabel>
            {!catalogConfig ? (
              <DropdownMenuItem
                onClick={handleReindex}
                disabled={reindexMutation.isPending}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Re-index
              </DropdownMenuItem>
            ) : null}
            {isApiCatalog ? (
              <>
                <DropdownMenuItem
                  onClick={handleRunCatalogSync}
                  disabled={
                    runCatalogSyncMutation.isPending ||
                    !catalogConfig?.syncConfigId
                  }
                >
                  <DatabaseZap className="mr-2 h-4 w-4" />
                  Run sync
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setEditCatalogOpen(true)}>
                  <Pencil className="mr-2 h-4 w-4" />
                  Edit sync
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setRunsOpen(true)}>
                  <History className="mr-2 h-4 w-4" />
                  Sync runs
                </DropdownMenuItem>
              </>
            ) : null}
            {isCsvCatalog ? (
              <DropdownMenuItem
                onClick={handleReimportCsvCatalog}
                disabled={reimportCsvCatalogMutation.isPending}
              >
                <DatabaseZap className="mr-2 h-4 w-4" />
                Re-import CSV
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => setDeleteDialogOpen(true)}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Knowledge Source</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{source.fileName}"? This action
              cannot be undone and will remove this knowledge source from your
              agent's knowledge base.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {isApiCatalog && catalogConfig?.syncConfigId ? (
        <>
          <CatalogSyncDialog
            agentId={agentId}
            config={{
              id: catalogConfig.syncConfigId,
              name: catalogConfig.name,
              scopeName: catalogConfig.scopeName,
              scopeAliases: catalogConfig.scopeAliases,
              experienceId: catalogConfig.experienceId,
              snapshotUrl: catalogConfig.snapshotUrl ?? "",
              diffUrl: catalogConfig.diffUrl ?? "",
              authHeaderName: catalogConfig.authHeaderName ?? null,
              authSecretName: catalogConfig.authSecretName ?? null,
              updatedSinceParam:
                catalogConfig.updatedSinceParam ?? "effectiveUpdatedAfter",
              itemPath: catalogConfig.itemPath ?? "",
              stableKeyField: catalogConfig.stableKeyField,
              updatedAtField: catalogConfig.updatedAtField,
              deletionField: catalogConfig.deletionField,
              deletionInactiveValues: catalogConfig.deletionInactiveValues,
              titleField: catalogConfig.titleField,
              searchableFields: catalogConfig.searchableFields,
              exactMatchFields: catalogConfig.exactMatchFields,
              filterableFields: catalogConfig.filterableFields,
              syncIntervalDays: catalogConfig.syncIntervalDays ?? 7,
              scheduleWeekdayUtc: catalogConfig.scheduleWeekdayUtc ?? 1,
              scheduleHourUtc: catalogConfig.scheduleHourUtc ?? 3,
              enabled: catalogConfig.enabled,
            }}
            open={editCatalogOpen}
            onOpenChange={setEditCatalogOpen}
          />
          <CatalogSyncRunsDialog
            configId={catalogConfig.syncConfigId}
            name={catalogConfig.name}
            open={runsOpen}
            onOpenChange={setRunsOpen}
          />
        </>
      ) : null}
    </>
  );
}

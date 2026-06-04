import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useTRPC } from "@/integrations/trpc/react";
import { formatDateTime } from "@/lib/utils";

interface CatalogSyncRunsDialogProps {
  configId: string;
  name: string;
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function statusVariant(status: string) {
  if (status === "succeeded") return "default";
  if (status === "failed") return "destructive";
  return "secondary";
}

export function CatalogSyncRunsDialog({
  configId,
  name,
  trigger,
  open,
  onOpenChange,
}: CatalogSyncRunsDialogProps) {
  const trpc = useTRPC();
  const { data: runs = [] } = useQuery(
    trpc.catalogSync.runs.queryOptions({ configId, limit: 20 }),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Catalog Sync Runs</DialogTitle>
          <DialogDescription>{name}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {runs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No runs yet.</p>
          ) : (
            runs.map((run) => {
              const stats = (run.stats ?? {}) as Record<string, unknown>;
              return (
                <div key={run.id} className="rounded border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Badge variant={statusVariant(run.status)}>
                        {run.status}
                      </Badge>
                      <span className="text-muted-foreground">
                        {run.trigger} / {run.mode}
                      </span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {formatDateTime(run.createdAt)}
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
                    <span>Fetched: {String(stats.fetched ?? 0)}</span>
                    <span>Pages: {String(stats.pagesFetched ?? 0)}</span>
                    <span>Created: {String(stats.created ?? 0)}</span>
                    <span>Updated: {String(stats.updated ?? 0)}</span>
                    <span>Hidden: {String(stats.deactivated ?? 0)}</span>
                  </div>
                  {run.error ? (
                    <p className="mt-2 text-xs text-destructive">{run.error}</p>
                  ) : null}
                  {run.workflowInstanceId ? (
                    <p className="mt-2 truncate font-mono text-xs text-muted-foreground">
                      {run.workflowInstanceId}
                    </p>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

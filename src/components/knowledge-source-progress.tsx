import { AlertCircle, Loader2, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import type { KnowledgeSource } from "@/db/schema";
import { cn } from "@/lib/utils";

type KnowledgeSourceProgressData = Pick<
  KnowledgeSource,
  "status" | "progress" | "progressMessage" | "retryCount" | "parserErrors"
>;

function getKnowledgeStatusTone(status: KnowledgeSource["status"]): string {
  switch (status) {
    case "indexed":
      return "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200";
    case "parsed":
      return "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200";
    case "failed":
      return "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200";
    case "processing":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200";
    default:
      return "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200";
  }
}

interface KnowledgeSourceProgressProps {
  source: KnowledgeSourceProgressData;
  compact?: boolean;
  className?: string;
}

export function KnowledgeSourceProgress({
  source,
  compact = false,
  className,
}: KnowledgeSourceProgressProps) {
  const progressValue =
    source.status === "indexed" ? 100 : Math.max(0, source.progress ?? 0);
  const showProgress = source.status === "processing";
  const retryCount = source.retryCount ?? 0;
  const failureMessage = source.parserErrors?.[0] || source.progressMessage;
  const activeMessage =
    source.status === "processing" ? source.progressMessage : undefined;

  return (
    <div className={cn("space-y-2", compact && "space-y-1.5", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium",
            getKnowledgeStatusTone(source.status),
          )}
        >
          {source.status === "processing" ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : null}
          {source.status}
        </span>
        {retryCount > 0 ? (
          <Badge
            variant="outline"
            className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300"
          >
            <RotateCcw className="h-3 w-3" />
            Retry {retryCount}
          </Badge>
        ) : null}
      </div>

      {showProgress ? (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Indexing progress</span>
            <span>{Math.round(progressValue)}%</span>
          </div>
          <Progress
            value={progressValue}
            className={cn(compact ? "h-2" : "h-2.5")}
          />
        </div>
      ) : null}

      {activeMessage && source.status !== "failed" ? (
        <p className="text-xs text-muted-foreground">{activeMessage}</p>
      ) : null}

      {source.status === "failed" && failureMessage ? (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{failureMessage}</span>
        </div>
      ) : null}
    </div>
  );
}

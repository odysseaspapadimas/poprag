import type { ColumnDef } from "@tanstack/react-table";
import { ArrowUpDown, AudioLines, FileText, Image, Video } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// Type for model alias from database
export interface ModelAliasRow {
  alias: string;
  provider: string;
  modelId: string;
  modelType: "chat" | "embedding" | "reranker";
  embeddingDimensions?: number | null;
  capabilities?: {
    inputModalities?: string[];
    outputModalities?: string[];
    toolCall?: boolean;
    reasoning?: boolean;
    structuredOutput?: boolean;
    attachment?: boolean;
    contextLength?: number;
    maxOutputTokens?: number;
    costInputPerMillion?: number;
    costOutputPerMillion?: number;
  } | null;
  updatedAt: Date;
}

// Format cost per million tokens
function formatCost(cost?: number | null): string {
  if (cost == null) return "—";
  if (cost === 0) return "$0";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

export const columns: ColumnDef<ModelAliasRow>[] = [
  {
    accessorKey: "alias",
    header: "Alias",
  },
  {
    accessorKey: "provider",
    header: "Provider",
  },
  {
    accessorKey: "modelId",
    header: "Model ID",
  },
  {
    id: "type",
    header: "Type",
    cell: ({ row }) => {
      const modelType = row.original.modelType;
      const dimensions = row.original.embeddingDimensions;

      return (
        <div className="flex items-center gap-1.5">
          <Badge
            variant={modelType === "chat" ? "secondary" : "outline"}
            className="text-[10px] px-1.5 py-0"
          >
            {modelType}
          </Badge>
          {modelType === "embedding" && dimensions && (
            <span className="text-[10px] text-muted-foreground">
              {dimensions}d
            </span>
          )}
        </div>
      );
    },
  },
  {
    id: "costInput",
    accessorFn: (row) => row.capabilities?.costInputPerMillion ?? null,
    header: ({ column }) => (
      <Button
        variant="ghost"
        size="sm"
        className="-ml-3 h-8"
        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
      >
        Input $/M
        <ArrowUpDown className="ml-1 h-3 w-3" />
      </Button>
    ),
    cell: ({ row }) => {
      const cost = row.original.capabilities?.costInputPerMillion;
      return (
        <span className={cost == null ? "text-muted-foreground" : ""}>
          {formatCost(cost)}
        </span>
      );
    },
    sortingFn: (rowA, rowB) => {
      const a = rowA.original.capabilities?.costInputPerMillion ?? -1;
      const b = rowB.original.capabilities?.costInputPerMillion ?? -1;
      return a - b;
    },
  },
  {
    id: "costOutput",
    accessorFn: (row) => row.capabilities?.costOutputPerMillion ?? null,
    header: ({ column }) => (
      <Button
        variant="ghost"
        size="sm"
        className="-ml-3 h-8"
        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
      >
        Output $/M
        <ArrowUpDown className="ml-1 h-3 w-3" />
      </Button>
    ),
    cell: ({ row }) => {
      const cost = row.original.capabilities?.costOutputPerMillion;
      return (
        <span className={cost == null ? "text-muted-foreground" : ""}>
          {formatCost(cost)}
        </span>
      );
    },
    sortingFn: (rowA, rowB) => {
      const a = rowA.original.capabilities?.costOutputPerMillion ?? -1;
      const b = rowB.original.capabilities?.costOutputPerMillion ?? -1;
      return a - b;
    },
  },
  {
    id: "capabilities",
    header: "Capabilities",
    cell: ({ row }) => {
      const caps = row.original.capabilities;
      if (!caps)
        return <span className="text-muted-foreground text-xs">—</span>;

      return (
        <div className="flex items-center gap-1 flex-wrap">
          {caps.inputModalities?.includes("image") && (
            <Image className="w-3 h-3 text-blue-500" />
          )}
          {caps.inputModalities?.includes("audio") && (
            <AudioLines className="w-3 h-3 text-green-500" />
          )}
          {caps.inputModalities?.includes("video") && (
            <Video className="w-3 h-3 text-purple-500" />
          )}
          {caps.inputModalities?.includes("pdf") && (
            <FileText className="w-3 h-3 text-orange-500" />
          )}
          {caps.toolCall && (
            <Badge variant="outline" className="text-[10px] px-1 py-0">
              tools
            </Badge>
          )}
          {caps.reasoning && (
            <Badge variant="outline" className="text-[10px] px-1 py-0">
              reason
            </Badge>
          )}
        </div>
      );
    },
  },
];

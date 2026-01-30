import { useSuspenseQuery } from "@tanstack/react-query";
import {
  type ColumnDef,
  type ExpandedState,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type Row,
  type SortingState,
  type Table as TableInstance,
  useReactTable,
} from "@tanstack/react-table";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Fragment, useMemo, useState } from "react";
import { RAGDebugPanel } from "@/components/rag-debug-panel";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTRPC } from "@/integrations/trpc/react";

interface Props {
  agentId: string;
}

type RagDebugInfo = ComponentProps<typeof RAGDebugPanel>["debugInfo"];

type RunMetricRow = {
  id: string;
  agentId: string;
  runId: string;
  conversationId: string | null;
  initiatedBy: string | null;
  initiatedByName: string | null;
  initiatedByEmail: string | null;
  modelAlias: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  tokens: number | null;
  costMicrocents: number | null;
  latencyMs: number | null;
  timeToFirstTokenMs: number | null;
  errorType: string | null;
  createdAt: number | Date;
  request: Record<string, unknown> | null;
  response: Record<string, unknown> | null;
};

type ConversationSummary = {
  id: string;
  conversationId: string;
  userLabel: string;
  initiatedBy: string | null;
  initiatedByName: string | null;
  initiatedByEmail: string | null;
  runCount: number;
  totalTokens: number;
  totalCostMicrocents: number;
  avgLatencyMs: number | null;
  avgTtftMs: number | null;
  errorCount: number;
  lastSeen: number;
  runs: RunMetricRow[];
};

type UserSummary = {
  id: string;
  userLabel: string;
  initiatedBy: string | null;
  initiatedByName: string | null;
  initiatedByEmail: string | null;
  runCount: number;
  totalTokens: number;
  totalCostMicrocents: number;
  avgLatencyMs: number | null;
  avgTtftMs: number | null;
  errorCount: number;
  lastSeen: number;
  runs: RunMetricRow[];
};

const formatCurrency = (microcents?: number | null) => {
  if (typeof microcents !== "number" || Number.isNaN(microcents)) return "-";
  const dollars = microcents / 1_000_000;
  return `$${dollars.toFixed(4)}`;
};

const formatNumber = (value?: number | null) => {
  if (typeof value !== "number" || Number.isNaN(value)) return "-";
  return value.toLocaleString();
};

const formatDate = (value: number | Date) => new Date(value).toLocaleString();

const computeAverage = (values: Array<number | null | undefined>) => {
  const filtered = values.filter(
    (value): value is number => typeof value === "number",
  );
  if (!filtered.length) return null;
  const total = filtered.reduce((acc, value) => acc + value, 0);
  return Math.round(total / filtered.length);
};

const formatUserLabel = (
  name?: string | null,
  email?: string | null,
  id?: string | null,
) => {
  if (name) return name;
  if (email) return email;
  if (id) return id;
  return "Anonymous";
};

const getRunTotalTokens = (metric: RunMetricRow) =>
  metric.totalTokens ?? metric.tokens ?? null;

const getRunPromptTokens = (metric: RunMetricRow) =>
  metric.promptTokens ?? null;

const getRunCompletionTokens = (metric: RunMetricRow) =>
  metric.completionTokens ?? null;

const getRagDebugInfo = (
  request: Record<string, unknown> | null,
): RagDebugInfo => {
  if (!request) return null;
  const ragDebug = (request as { ragDebug?: RagDebugInfo }).ragDebug;
  return ragDebug ?? null;
};

const extractLastUserMessage = (request: Record<string, unknown> | null) => {
  const messages = (request as { messages?: unknown[] } | null)?.messages;
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as {
      role?: string;
      parts?: Array<Record<string, unknown>>;
    };
    if (message?.role !== "user" || !Array.isArray(message.parts)) continue;
    const textPart = message.parts.find(
      (part) => part?.type === "text" && typeof part.text === "string",
    ) as { text?: string } | undefined;
    if (textPart?.text) return textPart.text;
  }
  return null;
};

const extractResponseText = (response: Record<string, unknown> | null) => {
  if (!response) return null;
  const text = (response as { text?: string }).text;
  return typeof text === "string" && text.trim().length > 0 ? text : null;
};

function MetricsTable<T>({
  table,
  renderExpanded,
  emptyMessage,
}: {
  table: TableInstance<T>;
  renderExpanded: (row: Row<T>) => ReactNode;
  emptyMessage: string;
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <Fragment key={row.id}>
                  <TableRow>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext(),
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                  {row.getIsExpanded() && (
                    <TableRow>
                      <TableCell
                        colSpan={table.getVisibleLeafColumns().length}
                        className="bg-muted/20"
                      >
                        {renderExpanded(row)}
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={table.getVisibleLeafColumns().length}
                  className="h-24 text-center text-muted-foreground"
                >
                  {emptyMessage}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => table.previousPage()}
          disabled={!table.getCanPreviousPage()}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => table.nextPage()}
          disabled={!table.getCanNextPage()}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

function RunDetails({ run }: { run: RunMetricRow }) {
  const ragDebug = getRagDebugInfo(run.request);
  const ragEnabled = Boolean(
    (ragDebug as { enabled?: boolean } | null)?.enabled,
  );
  const userPrompt = extractLastUserMessage(run.request);
  const responseText = extractResponseText(run.response);
  const promptTokens = getRunPromptTokens(run);
  const completionTokens = getRunCompletionTokens(run);
  const totalTokens = getRunTotalTokens(run);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
        <div className="rounded-md border bg-card p-3">
          <div className="text-xs text-muted-foreground">Run</div>
          <div className="text-xs font-mono break-all">{run.runId}</div>
        </div>
        <div className="rounded-md border bg-card p-3">
          <div className="text-xs text-muted-foreground">Conversation</div>
          <div className="text-xs font-mono break-all">
            {run.conversationId ?? "-"}
          </div>
        </div>
        <div className="rounded-md border bg-card p-3">
          <div className="text-xs text-muted-foreground">User</div>
          <div className="text-xs">
            {formatUserLabel(
              run.initiatedByName,
              run.initiatedByEmail,
              run.initiatedBy,
            )}
          </div>
        </div>
        <div className="rounded-md border bg-card p-3">
          <div className="text-xs text-muted-foreground">Model</div>
          <div className="text-xs font-mono break-all">
            {run.modelAlias ?? "-"}
          </div>
        </div>
        <div className="rounded-md border bg-card p-3">
          <div className="text-xs text-muted-foreground">Tokens</div>
          <div className="text-xs">
            {formatNumber(totalTokens)}
            {promptTokens != null || completionTokens != null
              ? ` (prompt ${formatNumber(promptTokens)} / completion ${formatNumber(
                  completionTokens,
                )})`
              : ""}
          </div>
        </div>
        <div className="rounded-md border bg-card p-3">
          <div className="text-xs text-muted-foreground">Cost</div>
          <div className="text-xs">{formatCurrency(run.costMicrocents)}</div>
        </div>
        <div className="rounded-md border bg-card p-3">
          <div className="text-xs text-muted-foreground">Latency</div>
          <div className="text-xs">
            {run.latencyMs != null ? `${run.latencyMs} ms` : "-"}
          </div>
        </div>
        <div className="rounded-md border bg-card p-3">
          <div className="text-xs text-muted-foreground">TTFT</div>
          <div className="text-xs">
            {run.timeToFirstTokenMs != null
              ? `${run.timeToFirstTokenMs} ms`
              : "-"}
          </div>
        </div>
        <div className="rounded-md border bg-card p-3">
          <div className="text-xs text-muted-foreground">Error</div>
          <div className="text-xs">{run.errorType ?? "-"}</div>
        </div>
      </div>
      {(userPrompt || responseText) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {userPrompt && (
            <div className="rounded-md border bg-card p-3">
              <div className="text-xs text-muted-foreground mb-2">
                User Message
              </div>
              <div className="text-xs whitespace-pre-wrap">{userPrompt}</div>
            </div>
          )}
          {responseText && (
            <div className="rounded-md border bg-card p-3">
              <div className="text-xs text-muted-foreground mb-2">Response</div>
              <div className="text-xs whitespace-pre-wrap">{responseText}</div>
            </div>
          )}
        </div>
      )}
      <div className="space-y-2">
        <div className="text-sm font-semibold">RAG Debug</div>
        {ragEnabled ? (
          <RAGDebugPanel debugInfo={ragDebug} />
        ) : (
          <div className="text-xs text-muted-foreground">
            No RAG debug info recorded.
          </div>
        )}
      </div>
    </div>
  );
}

function AggregateDetails({ runs }: { runs: RunMetricRow[] }) {
  const rows = runs.slice(0, 10);

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground">Latest runs</div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Tokens</TableHead>
              <TableHead>Cost</TableHead>
              <TableHead>Latency</TableHead>
              <TableHead>TTFT</TableHead>
              <TableHead>Error</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((run) => (
              <TableRow key={run.id}>
                <TableCell>{formatDate(run.createdAt)}</TableCell>
                <TableCell>{formatNumber(getRunTotalTokens(run))}</TableCell>
                <TableCell>{formatCurrency(run.costMicrocents)}</TableCell>
                <TableCell>
                  {run.latencyMs != null ? `${run.latencyMs} ms` : "-"}
                </TableCell>
                <TableCell>
                  {run.timeToFirstTokenMs != null
                    ? `${run.timeToFirstTokenMs} ms`
                    : "-"}
                </TableCell>
                <TableCell>{run.errorType ?? "-"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {runs.length > rows.length && (
        <div className="text-xs text-muted-foreground">
          Showing latest {rows.length} of {runs.length} runs.
        </div>
      )}
    </div>
  );
}

export function AgentMetrics({ agentId }: Props) {
  const trpc = useTRPC();
  const { data: metrics } = useSuspenseQuery(
    trpc.agent.getRunMetrics.queryOptions({ agentId, limit: 200 }),
  );

  const rows = (metrics ?? []) as RunMetricRow[];

  const totalRuns = rows.length;
  const totalTokens = rows.reduce(
    (acc, metric) => acc + (getRunTotalTokens(metric) ?? 0),
    0,
  );
  const totalCostMicrocents = rows.reduce(
    (acc, metric) => acc + (metric.costMicrocents ?? 0),
    0,
  );
  const latencyRows = rows.filter((metric) => metric.latencyMs != null);
  const avgLatency = latencyRows.length
    ? Math.round(
        latencyRows.reduce((acc, metric) => acc + (metric.latencyMs ?? 0), 0) /
          latencyRows.length,
      )
    : null;
  const ttftRows = rows.filter((metric) => metric.timeToFirstTokenMs != null);
  const avgTtft = ttftRows.length
    ? Math.round(
        ttftRows.reduce(
          (acc, metric) => acc + (metric.timeToFirstTokenMs ?? 0),
          0,
        ) / ttftRows.length,
      )
    : null;
  const errorCount = rows.filter((metric) => metric.errorType).length;
  const errorRate = totalRuns
    ? `${((errorCount / totalRuns) * 100).toFixed(1)}%`
    : "-";

  const [activeView, setActiveView] = useState<
    "runs" | "conversations" | "users"
  >("runs");

  const conversationRows = useMemo(() => {
    const grouped = new Map<string, ConversationSummary>();
    rows.forEach((metric) => {
      const conversationId = metric.conversationId ?? "unknown";
      const key = conversationId;
      const timestamp = new Date(metric.createdAt).getTime();
      const userLabel = formatUserLabel(
        metric.initiatedByName,
        metric.initiatedByEmail,
        metric.initiatedBy,
      );
      const existing = grouped.get(key);

      const totalTokensForRun = getRunTotalTokens(metric) ?? 0;
      const costForRun = metric.costMicrocents ?? 0;

      if (!existing) {
        grouped.set(key, {
          id: key,
          conversationId,
          userLabel,
          initiatedBy: metric.initiatedBy,
          initiatedByName: metric.initiatedByName,
          initiatedByEmail: metric.initiatedByEmail,
          runCount: 1,
          totalTokens: totalTokensForRun,
          totalCostMicrocents: costForRun,
          avgLatencyMs: null,
          avgTtftMs: null,
          errorCount: metric.errorType ? 1 : 0,
          lastSeen: timestamp,
          runs: [metric],
        });
        return;
      }

      existing.runCount += 1;
      existing.totalTokens += totalTokensForRun;
      existing.totalCostMicrocents += costForRun;
      existing.errorCount += metric.errorType ? 1 : 0;
      existing.lastSeen = Math.max(existing.lastSeen, timestamp);
      existing.runs.push(metric);
    });

    return Array.from(grouped.values())
      .map((summary) => ({
        ...summary,
        avgLatencyMs: computeAverage(summary.runs.map((run) => run.latencyMs)),
        avgTtftMs: computeAverage(
          summary.runs.map((run) => run.timeToFirstTokenMs),
        ),
      }))
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }, [rows]);

  const userRows = useMemo(() => {
    const grouped = new Map<string, UserSummary>();
    rows.forEach((metric) => {
      const userId = metric.initiatedBy ?? "unknown";
      const userLabel = formatUserLabel(
        metric.initiatedByName,
        metric.initiatedByEmail,
        metric.initiatedBy,
      );
      const timestamp = new Date(metric.createdAt).getTime();
      const existing = grouped.get(userId);
      const totalTokensForRun = getRunTotalTokens(metric) ?? 0;
      const costForRun = metric.costMicrocents ?? 0;

      if (!existing) {
        grouped.set(userId, {
          id: userId,
          userLabel,
          initiatedBy: metric.initiatedBy,
          initiatedByName: metric.initiatedByName,
          initiatedByEmail: metric.initiatedByEmail,
          runCount: 1,
          totalTokens: totalTokensForRun,
          totalCostMicrocents: costForRun,
          avgLatencyMs: null,
          avgTtftMs: null,
          errorCount: metric.errorType ? 1 : 0,
          lastSeen: timestamp,
          runs: [metric],
        });
        return;
      }

      existing.runCount += 1;
      existing.totalTokens += totalTokensForRun;
      existing.totalCostMicrocents += costForRun;
      existing.errorCount += metric.errorType ? 1 : 0;
      existing.lastSeen = Math.max(existing.lastSeen, timestamp);
      existing.runs.push(metric);
    });

    return Array.from(grouped.values())
      .map((summary) => ({
        ...summary,
        avgLatencyMs: computeAverage(summary.runs.map((run) => run.latencyMs)),
        avgTtftMs: computeAverage(
          summary.runs.map((run) => run.timeToFirstTokenMs),
        ),
      }))
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }, [rows]);

  const runColumns = useMemo<ColumnDef<RunMetricRow>[]>(
    () => [
      {
        id: "expander",
        header: "",
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={row.getToggleExpandedHandler()}
          >
            {row.getIsExpanded() ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </Button>
        ),
      },
      {
        accessorKey: "createdAt",
        header: "Date",
        cell: ({ row }) => formatDate(row.original.createdAt),
      },
      {
        id: "user",
        header: "User",
        cell: ({ row }) =>
          formatUserLabel(
            row.original.initiatedByName,
            row.original.initiatedByEmail,
            row.original.initiatedBy,
          ),
      },
      {
        accessorKey: "conversationId",
        header: "Conversation",
        cell: ({ row }) => row.original.conversationId ?? "-",
      },
      {
        accessorKey: "modelAlias",
        header: "Model",
        cell: ({ row }) => row.original.modelAlias ?? "-",
      },
      {
        id: "tokens",
        header: "Tokens",
        cell: ({ row }) => formatNumber(getRunTotalTokens(row.original)),
      },
      {
        accessorKey: "costMicrocents",
        header: "Cost",
        cell: ({ row }) => formatCurrency(row.original.costMicrocents),
      },
      {
        accessorKey: "latencyMs",
        header: "Latency (ms)",
        cell: ({ row }) =>
          row.original.latencyMs != null ? row.original.latencyMs : "-",
      },
      {
        accessorKey: "timeToFirstTokenMs",
        header: "TTFT (ms)",
        cell: ({ row }) =>
          row.original.timeToFirstTokenMs != null
            ? row.original.timeToFirstTokenMs
            : "-",
      },
      {
        accessorKey: "errorType",
        header: "Error",
        cell: ({ row }) => row.original.errorType ?? "-",
      },
    ],
    [],
  );

  const conversationColumns = useMemo<ColumnDef<ConversationSummary>[]>(
    () => [
      {
        id: "expander",
        header: "",
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={row.getToggleExpandedHandler()}
          >
            {row.getIsExpanded() ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </Button>
        ),
      },
      {
        accessorKey: "conversationId",
        header: "Conversation",
      },
      {
        accessorKey: "userLabel",
        header: "User",
      },
      {
        accessorKey: "runCount",
        header: "Runs",
      },
      {
        accessorKey: "totalTokens",
        header: "Tokens",
        cell: ({ row }) => formatNumber(row.original.totalTokens),
      },
      {
        accessorKey: "totalCostMicrocents",
        header: "Cost",
        cell: ({ row }) => formatCurrency(row.original.totalCostMicrocents),
      },
      {
        accessorKey: "avgLatencyMs",
        header: "Avg Latency",
        cell: ({ row }) =>
          row.original.avgLatencyMs != null
            ? `${row.original.avgLatencyMs} ms`
            : "-",
      },
      {
        accessorKey: "lastSeen",
        header: "Last Seen",
        cell: ({ row }) => formatDate(row.original.lastSeen),
      },
      {
        accessorKey: "errorCount",
        header: "Errors",
      },
    ],
    [],
  );

  const userColumns = useMemo<ColumnDef<UserSummary>[]>(
    () => [
      {
        id: "expander",
        header: "",
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={row.getToggleExpandedHandler()}
          >
            {row.getIsExpanded() ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </Button>
        ),
      },
      {
        accessorKey: "userLabel",
        header: "User",
      },
      {
        accessorKey: "runCount",
        header: "Runs",
      },
      {
        accessorKey: "totalTokens",
        header: "Tokens",
        cell: ({ row }) => formatNumber(row.original.totalTokens),
      },
      {
        accessorKey: "totalCostMicrocents",
        header: "Cost",
        cell: ({ row }) => formatCurrency(row.original.totalCostMicrocents),
      },
      {
        accessorKey: "avgLatencyMs",
        header: "Avg Latency",
        cell: ({ row }) =>
          row.original.avgLatencyMs != null
            ? `${row.original.avgLatencyMs} ms`
            : "-",
      },
      {
        accessorKey: "lastSeen",
        header: "Last Seen",
        cell: ({ row }) => formatDate(row.original.lastSeen),
      },
      {
        accessorKey: "errorCount",
        header: "Errors",
      },
    ],
    [],
  );

  const [runSorting, setRunSorting] = useState<SortingState>([
    { id: "createdAt", desc: true },
  ]);
  const [runExpanded, setRunExpanded] = useState<ExpandedState>({});
  const runTable = useReactTable({
    data: rows,
    columns: runColumns,
    state: { sorting: runSorting, expanded: runExpanded },
    onSortingChange: setRunSorting,
    onExpandedChange: setRunExpanded,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getRowCanExpand: () => true,
  });

  const [conversationSorting, setConversationSorting] = useState<SortingState>([
    { id: "lastSeen", desc: true },
  ]);
  const [conversationExpanded, setConversationExpanded] =
    useState<ExpandedState>({});
  const conversationTable = useReactTable({
    data: conversationRows,
    columns: conversationColumns,
    state: { sorting: conversationSorting, expanded: conversationExpanded },
    onSortingChange: setConversationSorting,
    onExpandedChange: setConversationExpanded,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getRowCanExpand: (row) => row.original.runs.length > 0,
  });

  const [userSorting, setUserSorting] = useState<SortingState>([
    { id: "lastSeen", desc: true },
  ]);
  const [userExpanded, setUserExpanded] = useState<ExpandedState>({});
  const userTable = useReactTable({
    data: userRows,
    columns: userColumns,
    state: { sorting: userSorting, expanded: userExpanded },
    onSortingChange: setUserSorting,
    onExpandedChange: setUserExpanded,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getRowCanExpand: (row) => row.original.runs.length > 0,
  });

  const viewControls = [
    { id: "runs", label: "Runs" },
    { id: "conversations", label: "Conversations" },
    { id: "users", label: "Users" },
  ] as const;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        <div className="bg-card border rounded-lg p-4">
          <div className="text-sm text-muted-foreground">Runs</div>
          <div className="text-xl font-semibold">{totalRuns}</div>
        </div>
        <div className="bg-card border rounded-lg p-4">
          <div className="text-sm text-muted-foreground">Tokens (total)</div>
          <div className="text-xl font-semibold">
            {formatNumber(totalTokens)}
          </div>
        </div>
        <div className="bg-card border rounded-lg p-4">
          <div className="text-sm text-muted-foreground">Cost (estimated)</div>
          <div className="text-xl font-semibold">
            {formatCurrency(totalCostMicrocents)}
          </div>
        </div>
        <div className="bg-card border rounded-lg p-4">
          <div className="text-sm text-muted-foreground">Avg Latency</div>
          <div className="text-xl font-semibold">
            {avgLatency != null ? `${avgLatency} ms` : "-"}
          </div>
        </div>
        <div className="bg-card border rounded-lg p-4">
          <div className="text-sm text-muted-foreground">Avg TTFT</div>
          <div className="text-xl font-semibold">
            {avgTtft != null ? `${avgTtft} ms` : "-"}
          </div>
        </div>
        <div className="bg-card border rounded-lg p-4">
          <div className="text-sm text-muted-foreground">Error Rate</div>
          <div className="text-xl font-semibold">{errorRate}</div>
        </div>
      </div>

      <div className="bg-card border rounded-lg p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-lg font-semibold">Analytics</h3>
          <div className="flex items-center gap-2">
            {viewControls.map((view) => (
              <Button
                key={view.id}
                type="button"
                variant={activeView === view.id ? "secondary" : "outline"}
                size="sm"
                onClick={() => setActiveView(view.id)}
              >
                {view.label}
              </Button>
            ))}
          </div>
        </div>

        {activeView === "runs" && (
          <MetricsTable
            table={runTable}
            emptyMessage="No metrics recorded yet."
            renderExpanded={(row) => <RunDetails run={row.original} />}
          />
        )}

        {activeView === "conversations" && (
          <MetricsTable
            table={conversationTable}
            emptyMessage="No conversations recorded yet."
            renderExpanded={(row) => (
              <AggregateDetails runs={row.original.runs} />
            )}
          />
        )}

        {activeView === "users" && (
          <MetricsTable
            table={userTable}
            emptyMessage="No users recorded yet."
            renderExpanded={(row) => (
              <AggregateDetails runs={row.original.runs} />
            )}
          />
        )}
      </div>
    </div>
  );
}

export default AgentMetrics;

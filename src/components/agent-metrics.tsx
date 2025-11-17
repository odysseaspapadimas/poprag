import { useTRPC } from "@/integrations/trpc/react";
import { useSuspenseQuery } from "@tanstack/react-query";

interface Props {
  agentId: string;
}

export function AgentMetrics({ agentId }: Props) {
  const trpc = useTRPC();
  const { data: metrics } = useSuspenseQuery(
    trpc.agent.getRunMetrics.queryOptions({ agentId, limit: 50 })
  );

  const totalRuns = metrics?.length ?? 0;
  const totalTokens = (metrics || []).reduce((acc, m) => acc + (m.tokens ?? 0), 0);
  const totalCostMicrocents = (metrics || []).reduce((acc, m) => acc + (m.costMicrocents ?? 0), 0);
  const avgLatency = Math.round((metrics || []).reduce((acc, m) => acc + (m.latencyMs ?? 0), 0) / Math.max(1, totalRuns));

  const formatCurrency = (microcents?: number | null) => {
    if (typeof microcents !== "number" || Number.isNaN(microcents)) return "-";
    const dollars = microcents / 1_000_000;
    return `$${dollars.toFixed(4)}`;
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-card border rounded-lg p-4">
          <div className="text-sm text-muted-foreground">Runs</div>
          <div className="text-xl font-semibold">{totalRuns}</div>
        </div>
        <div className="bg-card border rounded-lg p-4">
          <div className="text-sm text-muted-foreground">Tokens (total)</div>
          <div className="text-xl font-semibold">{totalTokens}</div>
        </div>
        <div className="bg-card border rounded-lg p-4">
          <div className="text-sm text-muted-foreground">Cost (estimated)</div>
          <div className="text-xl font-semibold">{formatCurrency(totalCostMicrocents)}</div>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="bg-card border rounded-lg p-4">
          <div className="text-sm text-muted-foreground">Average Latency</div>
          <div className="text-xl font-semibold">{avgLatency} ms</div>
        </div>
      </div>

      <div className="bg-card border rounded p-4">
        <h3 className="text-lg font-semibold mb-3">Recent Runs</h3>
        {(!metrics || metrics.length === 0) && (
          <div className="text-sm text-muted-foreground">No metrics recorded yet.</div>
        )}
        {metrics && metrics.length > 0 && (
          <div className="overflow-auto">
            <table className="w-full text-sm table-fixed">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="w-40">Date</th>
                  <th>Tokens</th>
                  <th>Cost</th>
                  <th>Latency (ms)</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {metrics.map((m) => (
                  <tr key={m.id} className="border-t">
                    <td className="py-2 align-top">
                      {new Date(m.createdAt).toLocaleString()}
                    </td>
                    <td className="py-2 align-top">{m.tokens ?? "-"}</td>
                    <td className="py-2 align-top">{formatCurrency(m.costMicrocents)}</td>
                    <td className="py-2 align-top">{m.latencyMs ?? "-"}</td>
                    <td className="py-2 align-top">{m.errorType ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default AgentMetrics;

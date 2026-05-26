import { createFileRoute } from "@tanstack/react-router";
import AgentMetrics from "@/components/agent-metrics";

export const Route = createFileRoute("/_app/analytics/")({
  component: AnalyticsPage,
});

function AnalyticsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Analytics</h1>
        <p className="text-muted-foreground mt-1">
          Track usage and retrieval health across your agents.
        </p>
      </div>
      <AgentMetrics />
    </div>
  );
}

export default AnalyticsPage;

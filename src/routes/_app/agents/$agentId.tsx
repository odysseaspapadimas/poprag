import { KnowledgeSourceActions } from "@/components/knowledge-source-actions";
import { KnowledgeUploadDialog } from "@/components/knowledge-upload-dialog";
import { Button } from "@/components/ui/button";
import { useTRPC } from "@/integrations/trpc/react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/agents/$agentId")({
  component: AgentDetailPage,
  validateSearch: (search) => ({
    tab: (search.tab as Tab) || "overview",
  }),
  loader: async ({ context, params }) => {
    const agentId = params.agentId as string;
    // Prefetch all data for this agent
    await Promise.all([
      context.queryClient.prefetchQuery(
        context.trpc.agent.get.queryOptions({ id: agentId })
      ),
      context.queryClient.prefetchQuery(
        context.trpc.agent.getKnowledgeSources.queryOptions({ agentId })
      ),
      context.queryClient.prefetchQuery(
        context.trpc.agent.getIndexPin.queryOptions({ agentId })
      ),
      context.queryClient.prefetchQuery(
        context.trpc.agent.getAuditLog.queryOptions({ agentId, limit: 20 })
      ),
    ]);
  },
});

type Tab =
  | "overview"
  | "prompts"
  | "models"
  | "knowledge"
  | "guardrails"
  | "sandbox"
  | "analytics"
  | "audit";

function AgentDetailPage() {
  const { agentId } = Route.useParams();
  const { tab: activeTab } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const trpc = useTRPC();

  // Fetch agent data with suspense
  const { data: agent } = useSuspenseQuery(
    trpc.agent.get.queryOptions({ id: agentId })
  );

  const { data: knowledgeSources } = useSuspenseQuery(
    trpc.agent.getKnowledgeSources.queryOptions({ agentId })
  );

  const { data: indexPin } = useSuspenseQuery(
    trpc.agent.getIndexPin.queryOptions({ agentId })
  );

  const { data: auditLog } = useSuspenseQuery(
    trpc.agent.getAuditLog.queryOptions({ agentId, limit: 20 })
  );

  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "prompts", label: "Prompts" },
    { id: "models", label: "Models & Knobs" },
    { id: "knowledge", label: "Knowledge" },
    { id: "guardrails", label: "Guardrails" },
    { id: "sandbox", label: "Sandbox" },
    { id: "analytics", label: "Analytics" },
    { id: "audit", label: "Audit Log" },
  ];

  return (
    <div className="container mx-auto py-8 max-w-6xl">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
          <Link to="/agents" className="hover:text-foreground">
            Agents
          </Link>
          <span>/</span>
          <span>{agent.name}</span>
        </div>
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-3xl font-bold">{agent.name}</h1>
            <p className="text-muted-foreground mt-1">/{agent.slug}</p>
            {agent.description && (
              <p className="text-sm mt-2">{agent.description}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`px-3 py-1 rounded-full text-xs font-medium ${
                agent.status === "active"
                  ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                  : agent.status === "draft"
                  ? "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200"
                  : "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200"
              }`}
            >
              {agent.status}
            </span>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b mb-6">
        <div className="flex gap-4 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() =>
                navigate({
                  search: { tab: tab.id },
                  replace: true,
                })
              }
              className={`px-4 py-2 border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab.id
                  ? "border-primary text-primary font-medium"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      <div>
        {activeTab === "overview" && (
          <div className="space-y-6">
            <div className="bg-card border rounded-lg p-6">
              <h2 className="text-xl font-semibold mb-4">Agent Information</h2>
              <dl className="grid grid-cols-2 gap-4">
                <div>
                  <dt className="text-sm font-medium text-muted-foreground">
                    ID
                  </dt>
                  <dd className="text-sm font-mono">{agent.id}</dd>
                </div>
                <div>
                  <dt className="text-sm font-medium text-muted-foreground">
                    Visibility
                  </dt>
                  <dd className="text-sm">{agent.visibility}</dd>
                </div>
                <div>
                  <dt className="text-sm font-medium text-muted-foreground">
                    Created
                  </dt>
                  <dd className="text-sm">
                    {new Date(agent.createdAt).toLocaleDateString()}
                  </dd>
                </div>
                <div>
                  <dt className="text-sm font-medium text-muted-foreground">
                    Last Updated
                  </dt>
                  <dd className="text-sm">
                    {new Date(agent.updatedAt).toLocaleDateString()}
                  </dd>
                </div>
                {indexPin && (
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">
                      Active Index Version
                    </dt>
                    <dd className="text-sm">v{indexPin.indexVersion}</dd>
                  </div>
                )}
              </dl>
            </div>

            <div className="bg-card border rounded-lg p-6">
              <h2 className="text-xl font-semibold mb-4">
                Knowledge Sources ({knowledgeSources.length})
              </h2>
              {knowledgeSources.length > 0 ? (
                <div className="space-y-2">
                  {knowledgeSources.slice(0, 5).map((source) => (
                    <div
                      key={source.id}
                      className="flex justify-between items-center p-3 bg-muted rounded"
                    >
                      <div>
                        <p className="text-sm font-medium">{source.fileName}</p>
                        <p className="text-xs text-muted-foreground">
                          {source.mime} •{" "}
                          {((source.bytes ?? 0) / 1024).toFixed(2)} KB
                        </p>
                      </div>
                      <span
                        className={`px-2 py-1 rounded text-xs ${
                          source.status === "indexed"
                            ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                            : source.status === "parsed"
                            ? "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
                            : source.status === "failed"
                            ? "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
                            : "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200"
                        }`}
                      >
                        {source.status}
                      </span>
                    </div>
                  ))}
                  {knowledgeSources.length > 5 && (
                    <p className="text-sm text-muted-foreground text-center pt-2">
                      +{knowledgeSources.length - 5} more
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No knowledge sources yet
                </p>
              )}
            </div>

            <div className="bg-card border rounded-lg p-6">
              <h2 className="text-xl font-semibold mb-4">
                Recent Activity ({auditLog.length})
              </h2>
              {auditLog.length > 0 ? (
                <div className="space-y-2">
                  {auditLog.slice(0, 5).map((log) => (
                    <div
                      key={log.id}
                      className="flex justify-between items-start p-3 bg-muted rounded"
                    >
                      <div>
                        <p className="text-sm font-medium">{log.eventType}</p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(log.createdAt).toLocaleString()}
                        </p>
                      </div>
                    </div>
                  ))}
                  {auditLog.length > 5 && (
                    <p className="text-sm text-muted-foreground text-center pt-2">
                      +{auditLog.length - 5} more
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No activity yet</p>
              )}
            </div>
          </div>
        )}

        {activeTab === "prompts" && (
          <div className="bg-card border rounded-lg p-6">
            <h2 className="text-xl font-semibold mb-4">Prompt Management</h2>
            <p className="text-muted-foreground">
              Prompt versioning and management coming soon...
            </p>
          </div>
        )}

        {activeTab === "models" && (
          <div className="bg-card border rounded-lg p-6">
            <h2 className="text-xl font-semibold mb-4">Models & Knobs</h2>
            <p className="text-muted-foreground">
              Model configuration coming soon...
            </p>
          </div>
        )}

        {activeTab === "knowledge" && (
          <div className="bg-card border rounded-lg p-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-semibold">Knowledge Management</h2>
              <KnowledgeUploadDialog
                agentId={agentId}
                trigger={<Button>Upload Knowledge Source</Button>}
              />
            </div>
            <div className="space-y-4">
              {knowledgeSources.map((source) => (
                <div
                  key={source.id}
                  className="flex justify-between items-center p-4 border rounded"
                >
                  <div>
                    <p className="font-medium">{source.fileName}</p>
                    <p className="text-sm text-muted-foreground">
                      {source.mime} • {((source.bytes ?? 0) / 1024).toFixed(2)}{" "}
                      KB • {new Date(source.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`px-2 py-1 rounded text-xs ${
                        source.status === "indexed"
                          ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                          : source.status === "parsed"
                          ? "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
                          : source.status === "failed"
                          ? "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
                          : "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200"
                      }`}
                    >
                      {source.status}
                    </span>
                    <KnowledgeSourceActions source={source} agentId={agentId} />
                  </div>
                </div>
              ))}
              {knowledgeSources.length === 0 && (
                <p className="text-center text-muted-foreground py-8">
                  No knowledge sources. Upload files to get started.
                </p>
              )}
            </div>
          </div>
        )}

        {activeTab === "guardrails" && (
          <div className="bg-card border rounded-lg p-6">
            <h2 className="text-xl font-semibold mb-4">Guardrails</h2>
            <p className="text-muted-foreground">
              Guardrail configuration coming soon...
            </p>
          </div>
        )}

        {activeTab === "sandbox" && (
          <div className="bg-card border rounded-lg p-6">
            <h2 className="text-xl font-semibold mb-4">Sandbox</h2>
            <p className="text-muted-foreground">
              Test your agent in a sandbox environment...
            </p>
          </div>
        )}

        {activeTab === "analytics" && (
          <div className="bg-card border rounded-lg p-6">
            <h2 className="text-xl font-semibold mb-4">Analytics</h2>
            <p className="text-muted-foreground">
              Usage analytics and metrics coming soon...
            </p>
          </div>
        )}

        {activeTab === "audit" && (
          <div className="bg-card border rounded-lg p-6">
            <h2 className="text-xl font-semibold mb-4">Audit Log</h2>
            <div className="space-y-2">
              {auditLog.map((log) => (
                <div
                  key={log.id}
                  className="flex justify-between items-start p-3 bg-muted rounded"
                >
                  <div className="flex-1">
                    <p className="text-sm font-medium">{log.eventType}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {log.targetType} • {log.targetId}
                    </p>
                    {log.diff && (
                      <pre className="text-xs mt-2 bg-background p-2 rounded overflow-auto">
                        {JSON.stringify(log.diff, null, 2)}
                      </pre>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground whitespace-nowrap ml-4">
                    {new Date(log.createdAt).toLocaleString()}
                  </div>
                </div>
              ))}
              {auditLog.length === 0 && (
                <p className="text-center text-muted-foreground py-8">
                  No audit log entries yet
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

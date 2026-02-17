import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { useState } from "react";
import AgentMetrics from "@/components/agent-metrics";
import { Chat } from "@/components/chat";
import { EditAgentDialog } from "@/components/edit-agent-dialog";
import { KnowledgeSourceActions } from "@/components/knowledge-source-actions";
import { KnowledgeSourceViewer } from "@/components/knowledge-source-viewer";
import { KnowledgeUploadDialog } from "@/components/knowledge-upload-dialog";
import { ModelPolicyEditor } from "@/components/model-policy-editor";
import { PromptManagement } from "@/components/prompt-management";
import { RAGSettings } from "@/components/rag-settings";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useTRPC } from "@/integrations/trpc/react";
import { formatDate, formatDateTime } from "@/lib/utils";

export const Route = createFileRoute("/_app/agents/$agentId/")({
  component: AgentDetailPage,
  validateSearch: (search) => ({
    tab: (search.tab as Tab) || "overview",
  }),
  loader: async ({ context, params }) => {
    const agentId = params.agentId as string;
    // Prefetch all data for this agent
    await Promise.all([
      context.queryClient.prefetchQuery(
        context.trpc.agent.get.queryOptions({ id: agentId }),
      ),
      context.queryClient.prefetchQuery(
        context.trpc.prompt.list.queryOptions({ agentId }),
      ),
      context.queryClient.prefetchQuery(
        context.trpc.agent.getKnowledgeSources.queryOptions({ agentId }),
      ),
      context.queryClient.prefetchQuery(
        context.trpc.agent.getIndexPin.queryOptions({ agentId }),
      ),
      context.queryClient.prefetchQuery(
        context.trpc.agent.getModelPolicy.queryOptions({ agentId }),
      ),
      context.queryClient.prefetchQuery(context.trpc.model.list.queryOptions()),
      context.queryClient.prefetchQuery(
        context.trpc.agent.getAuditLog.queryOptions({ agentId, limit: 20 }),
      ),
      context.queryClient.prefetchQuery(
        context.trpc.agent.getRunMetrics.queryOptions({ agentId }),
      ),
      context.queryClient.prefetchQuery(
        context.trpc.agent.getSetupStatus.queryOptions({ agentId }),
      ),
    ]);
  },
});

type Tab =
  | "overview"
  | "prompts"
  | "models"
  | "knowledge"
  | "rag"
  | "analytics"
  | "audit";

function AgentDetailPage() {
  const { agentId } = Route.useParams();
  const { tab: activeTab } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [viewingSource, setViewingSource] = useState<{
    id: string;
    fileName: string;
    mime: string | null;
  } | null>(null);
  const [isChatVisible, setIsChatVisible] = useState(true);

  // Callback to invalidate analytics when a chat message is completed
  const handleMessageComplete = () => {
    queryClient.invalidateQueries({
      queryKey: trpc.agent.getRunMetrics.queryKey({ agentId }),
      exact: false,
    });
  };

  // Fetch agent data with suspense
  const { data: agent } = useSuspenseQuery(
    trpc.agent.get.queryOptions({ id: agentId }),
  );

  const { data: knowledgeSources } = useSuspenseQuery(
    trpc.agent.getKnowledgeSources.queryOptions({ agentId }),
  );

  const { data: indexPin } = useSuspenseQuery(
    trpc.agent.getIndexPin.queryOptions({ agentId }),
  );

  const { data: modelPolicy } = useSuspenseQuery(
    trpc.agent.getModelPolicy.queryOptions({ agentId }),
  );

  const { data: auditLog } = useSuspenseQuery(
    trpc.agent.getAuditLog.queryOptions({ agentId, limit: 20 }),
  );

  const { data: setupStatus } = useSuspenseQuery(
    trpc.agent.getSetupStatus.queryOptions({ agentId }),
  );

  if (!agent) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold">Agent not found</h1>
        <p className="text-muted-foreground mt-2">
          The agent you are looking for does not exist or you do not have
          access.
        </p>
        <div className="mt-4">
          <Link to="/agents">
            <Button variant="outline">Back to Agents</Button>
          </Link>
        </div>
      </div>
    );
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "prompts", label: "Prompts" },
    { id: "models", label: "Models & Knobs" },
    { id: "knowledge", label: "Knowledge" },
    { id: "rag", label: "RAG Settings" },
    { id: "analytics", label: "Analytics" },
    { id: "audit", label: "Audit Log" },
  ];

  return (
    <div>
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
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsChatVisible(!isChatVisible)}
              title={isChatVisible ? "Hide chat panel" : "Show chat panel"}
            >
              {isChatVisible ? (
                <PanelRightClose className="h-4 w-4" />
              ) : (
                <PanelRightOpen className="h-4 w-4" />
              )}
              <span className="ml-2 hidden sm:inline">
                {isChatVisible ? "Hide Chat" : "Show Chat"}
              </span>
            </Button>
            <EditAgentDialog
              agent={agent}
              trigger={
                <Button variant="outline" size="sm" data-edit-settings>
                  Edit Settings
                </Button>
              }
            />
          </div>
        </div>
        {(!setupStatus?.hasModelAlias ||
          !setupStatus?.hasProdPrompt ||
          !setupStatus?.isActive) && (
          <div className="mt-4">
            <Alert variant="destructive">
              <div className="flex-1">
                <AlertTitle>Agent not fully configured</AlertTitle>
                <AlertDescription>
                  {!setupStatus?.isActive && (
                    <div>
                      Agent is not active.{" "}
                      <button
                        type="button"
                        onClick={() =>
                          (
                            document.querySelector(
                              "[data-edit-settings]",
                            ) as HTMLElement
                          )?.click()
                        }
                        className="underline hover:no-underline"
                      >
                        Edit settings
                      </button>{" "}
                      to activate.
                    </div>
                  )}
                  {!setupStatus?.hasModelAlias && (
                    <div>
                      No model selected.{" "}
                      <button
                        type="button"
                        onClick={() =>
                          navigate({ search: { tab: "models" }, replace: true })
                        }
                        className="underline hover:no-underline"
                      >
                        Configure models
                      </button>
                      .
                    </div>
                  )}
                  {!setupStatus?.hasProdPrompt && (
                    <div>
                      No production prompt found.{" "}
                      <button
                        type="button"
                        onClick={() =>
                          navigate({
                            search: { tab: "prompts" },
                            replace: true,
                          })
                        }
                        className="underline hover:no-underline"
                      >
                        Manage prompts
                      </button>
                      .
                    </div>
                  )}
                </AlertDescription>
              </div>
            </Alert>
          </div>
        )}
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

      {/* Content */}
      <div
        className={`grid grid-cols-1 gap-6 ${isChatVisible ? "lg:grid-cols-2" : ""}`}
      >
        {/* Tab Content */}
        <div>
          {activeTab === "overview" && (
            <div className="space-y-6">
              <div className="bg-card border rounded-lg p-6">
                <h2 className="text-xl font-semibold mb-4">
                  Agent Information
                </h2>
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
                      Model Alias
                    </dt>
                    <dd className="text-sm">
                      {modelPolicy?.modelAlias ?? "-"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">
                      Created
                    </dt>
                    <dd className="text-sm">{formatDate(agent.createdAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-muted-foreground">
                      Last Updated
                    </dt>
                    <dd className="text-sm">{formatDate(agent.updatedAt)}</dd>
                  </div>
                  {(() => {
                    const lastUpdateLog = auditLog.find(
                      (log) =>
                        log.eventType === "agent.updated" &&
                        log.targetType === "agent" &&
                        log.targetId === agent.id,
                    );
                    return lastUpdateLog ? (
                      <div>
                        <dt className="text-sm font-medium text-muted-foreground">
                          Updated By
                        </dt>
                        <dd className="text-sm">
                          {lastUpdateLog.actorName || lastUpdateLog.actorEmail}
                        </dd>
                      </div>
                    ) : null;
                  })()}
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
                          <button
                            type="button"
                            onClick={() =>
                              setViewingSource({
                                id: source.id,
                                fileName: source.fileName || "Unknown",
                                mime: source.mime,
                              })
                            }
                            className="text-sm font-medium hover:text-primary transition-colors text-left"
                          >
                            {source.fileName}
                          </button>
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
                      <div key={log.id} className="p-3 bg-muted rounded">
                        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-1">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium">
                              {log.eventType}
                            </p>
                            <p className="text-xs text-muted-foreground overflow-wrap-anywhere">
                              by {log.actorName || log.actorEmail}
                            </p>
                          </div>
                          <div className="text-xs text-muted-foreground shrink-0">
                            {formatDateTime(log.createdAt)}
                          </div>
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
                  <p className="text-sm text-muted-foreground">
                    No activity yet
                  </p>
                )}
              </div>
            </div>
          )}

          {activeTab === "prompts" && <PromptManagement agentId={agentId} />}

          {activeTab === "models" && (
            <div className="bg-card border rounded-lg p-6">
              <h2 className="text-xl font-semibold mb-4">Models & Knobs</h2>
              <ModelPolicyEditor agentId={agentId} />
              {/* Model alias management has moved to the dedicated Models page */}
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
                      <button
                        type="button"
                        onClick={() =>
                          setViewingSource({
                            id: source.id,
                            fileName: source.fileName || "Unknown",
                            mime: source.mime,
                          })
                        }
                        className="font-medium hover:text-primary transition-colors text-left"
                      >
                        {source.fileName}
                      </button>
                      <p className="text-sm text-muted-foreground">
                        {source.mime} •{" "}
                        {((source.bytes ?? 0) / 1024).toFixed(2)} KB •{" "}
                        {formatDate(source.createdAt)}
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
                      <KnowledgeSourceActions
                        source={source}
                        agentId={agentId}
                      />
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

          {activeTab === "rag" && (
            <div className="bg-card border rounded-lg p-6">
              <h2 className="text-xl font-semibold mb-4">RAG Settings</h2>
              <p className="text-muted-foreground mb-6">
                Configure how your agent retrieves and processes information
                from knowledge sources.
              </p>
              <RAGSettings agentId={agentId} />
            </div>
          )}

          {activeTab === "analytics" && (
            <div className="bg-card border rounded-lg p-6">
              <AgentMetrics agentId={agentId} />
            </div>
          )}

          {activeTab === "audit" && (
            <div className="bg-card border rounded-lg p-6">
              <h2 className="text-xl font-semibold mb-4">Audit Log</h2>
              <div className="space-y-2">
                {auditLog.map((log) => (
                  <div key={log.id} className="p-3 bg-muted rounded space-y-2">
                    <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">{log.eventType}</p>
                        <p className="text-xs text-muted-foreground mt-1 overflow-wrap-anywhere">
                          by {log.actorName || log.actorEmail} •{" "}
                          {log.targetType} •{" "}
                          <span className="font-mono text-xs">
                            {log.targetId.slice(0, 8)}...
                          </span>
                        </p>
                      </div>
                      <div className="text-xs text-muted-foreground shrink-0">
                        {formatDateTime(log.createdAt)}
                      </div>
                    </div>
                    {log.diff && (
                      <pre className="text-xs mt-2 bg-background p-2 rounded overflow-x-auto max-w-full">
                        {JSON.stringify(log.diff, null, 2)}
                      </pre>
                    )}
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

        {/* Chat */}
        {isChatVisible && (
          <div className="bg-card border rounded-lg overflow-hidden h-[600px] flex flex-col">
            <Chat agentId={agentId} onMessageComplete={handleMessageComplete} />
          </div>
        )}
      </div>

      {/* Knowledge Source Viewer Modal */}
      {viewingSource && (
        <KnowledgeSourceViewer
          sourceId={viewingSource.id}
          fileName={viewingSource.fileName}
          mime={viewingSource.mime}
          open={!!viewingSource}
          onOpenChange={(open) => {
            if (!open) {
              setViewingSource(null);
            }
          }}
        />
      )}
    </div>
  );
}

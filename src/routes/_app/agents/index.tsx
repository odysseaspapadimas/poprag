import type { QueryClient } from "@tanstack/react-query";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { TRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { CreateAgentForm } from "@/components/create-agent-form";
import { PageHeaderWithDialog } from "@/components/page-header-with-dialog";
import { columns } from "@/components/tables/columns";
import { DataTable } from "@/components/tables/data-table";
import { useTRPC } from "@/integrations/trpc/react";
import type { AppRouter } from "@/integrations/trpc/router";

type AgentsRouteContext = {
  queryClient: QueryClient;
  trpc: TRPCOptionsProxy<AppRouter>;
};

export const Route = createFileRoute("/_app/agents/")({
  component: AgentsPage,
  beforeLoad: async ({ context }: { context: AgentsRouteContext }) => {
    await context.queryClient.prefetchQuery(
      context.trpc.agent.list.queryOptions(),
    );
  },
});

function AgentsPage() {
  const trpc = useTRPC();

  // Fetch agents with suspense
  const { data: agents } = useSuspenseQuery(trpc.agent.list.queryOptions());

  return (
    <div>
      <PageHeaderWithDialog
        title="Agents"
        description="Manage your AI agents and their knowledge bases"
        buttonText="Create Agent"
        dialogTitle="Create New Agent"
        dialogDescription="Create a new AI agent with a custom knowledge base. The slug will be used in the agent's URL."
      >
        <CreateAgentForm />
      </PageHeaderWithDialog>
      <DataTable columns={columns} data={agents} />
    </div>
  );
}

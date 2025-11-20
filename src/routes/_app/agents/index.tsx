import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CreateAgentForm } from "@/components/create-agent-form";
import { PageHeaderWithDialog } from "@/components/page-header-with-dialog";
import { columns } from "@/components/tables/columns";
import { DataTable } from "@/components/tables/data-table";
import { useTRPC } from "@/integrations/trpc/react";

export const Route = createFileRoute("/_app/agents/")({
  component: AgentsPage,
  beforeLoad: async ({ context }) => {
    await context.queryClient.prefetchQuery(
      context.trpc.agent.list.queryOptions(),
    );
    await context.queryClient.prefetchQuery(
      context.trpc.model.list.queryOptions(),
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

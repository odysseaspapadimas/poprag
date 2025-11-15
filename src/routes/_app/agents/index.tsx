import { CreateAgentDialog } from "@/components/create-agent-dialog";
import { columns } from "@/components/tables/columns";
import { DataTable } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { useTRPC } from "@/integrations/trpc/react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/agents/")({
  component: AgentsPage,
  beforeLoad: async ({ context }) => {
    await context.queryClient.prefetchQuery(
      context.trpc.agent.list.queryOptions()
    );
    await context.queryClient.prefetchQuery(
      context.trpc.model.list.queryOptions()
    );
  },
});

function AgentsPage() {
  const trpc = useTRPC();

  // Fetch agents with suspense
  const { data: agents } = useSuspenseQuery(trpc.agent.list.queryOptions());

  return (
    <div>
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold">Agents</h1>
          <p className="text-muted-foreground mt-2">
            Manage your AI agents and their knowledge bases
          </p>
        </div>
        <CreateAgentDialog trigger={<Button>Create Agent</Button>} />
      </div>
      <DataTable columns={columns} data={agents} />
    </div>
  );
}

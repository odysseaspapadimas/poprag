import { ModelAliasManagement } from "@/components/model-alias-management";
import { useTRPC } from "@/integrations/trpc/react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/models/")({
  component: ModelsPage,
  beforeLoad: async ({ context }) => {
    // Prefetch model alias list for performance
    await context.queryClient.prefetchQuery(context.trpc.model.list.queryOptions());
  },
});

function ModelsPage() {
  // ensure we have TRPC context
  const trpc = useTRPC();
  useSuspenseQuery(trpc.model.list.queryOptions());

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Models & Aliases</h1>
      <ModelAliasManagement />
    </div>
  );
}

export default ModelsPage;

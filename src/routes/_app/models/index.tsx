import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CreateModelAliasForm } from "@/components/create-model-alias-form";
import { ModelAliasManagement } from "@/components/model-alias-management";
import { PageHeaderWithDialog } from "@/components/page-header-with-dialog";
import { useTRPC } from "@/integrations/trpc/react";

export const Route = createFileRoute("/_app/models/")({
  component: ModelsPage,
  beforeLoad: async ({ context }) => {
    // Prefetch model alias list for performance
    await context.queryClient.prefetchQuery(
      context.trpc.model.list.queryOptions(),
    );
  },
});

function ModelsPage() {
  // ensure we have TRPC context
  const trpc = useTRPC();
  useSuspenseQuery(trpc.model.list.queryOptions());

  return (
    <div>
      <PageHeaderWithDialog
        title="Model Aliases"
        description="Manage your model aliases for different AI providers"
        buttonText="Create Alias"
        dialogTitle="Create Model Alias"
      >
        <CreateModelAliasForm />
      </PageHeaderWithDialog>
      <ModelAliasManagement />
    </div>
  );
}

export default ModelsPage;

import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { columns } from "@/components/tables/columns-users";
import { DataTable } from "@/components/tables/data-table";
import { UserDetailsModal } from "@/components/user-details-modal";
import { useTRPC } from "@/integrations/trpc/react";

export const Route = createFileRoute("/_app/users")({
  loader: async ({ context }) =>
    await context.queryClient.ensureQueryData(
      context.trpc.user.getAll.queryOptions(),
    ),
  component: RouteComponent,
});

function RouteComponent() {
  const trpc = useTRPC();
  const { data } = useSuspenseQuery(trpc.user.getAll.queryOptions());
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const handleViewUser = (uid: string) => {
    setSelectedUserId(uid);
  };

  return (
    <article className="space-y-4">
      <h1 className="font-extrabold text-2xl">Users</h1>
      <section>
        <DataTable
          columns={columns(handleViewUser)}
          data={data}
          filterColumn="email"
        />
      </section>

      {selectedUserId && (
        <UserDetailsModal
          uid={selectedUserId}
          open={!!selectedUserId}
          onOpenChange={(open) => !open && setSelectedUserId(null)}
        />
      )}
    </article>
  );
}

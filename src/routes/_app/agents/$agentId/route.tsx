import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/agents/$agentId")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <div className="container mx-auto h-full flex flex-col">
      <Outlet />
    </div>
  );
}

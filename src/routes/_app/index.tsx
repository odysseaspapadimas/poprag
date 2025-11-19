import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/")({
  component: RouteComponent,
  beforeLoad: () => {
    throw redirect({
      to: "/agents",
    });
  },
});

function RouteComponent() {
  return <Outlet />;
}

// This _app component functions as a layout component that wraps all authenticated routes in the app. It is a good place to put things like a header, footer, or sidebar that you want to appear on every page of your app.
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { AppSidebar } from "@/components/app-sidebar";
import { DefaultCatchBoundary } from "@/components/default-catch-boundary";
import { Separator } from "@/components/ui/separator";
import {
    SidebarInset,
    SidebarProvider,
    SidebarTrigger,
} from "@/components/ui/sidebar";

export const Route = createFileRoute("/_app")({
  beforeLoad: ({ context: { session } }) => {
    if (!session?.session) {
      throw redirect({
        to: "/auth/sign-in",
      });
    }
    return { session };
  },
  errorComponent: DefaultCatchBoundary,
  component: LayoutComponent,
});

// This layout component includes a sidebar and main content area.
function LayoutComponent() {
  const { session } = Route.useRouteContext();

  return (
    <SidebarProvider>
      <AppSidebar user={session?.user} />
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
          <div className="flex items-center gap-2 px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 h-4" />
          </div>
        </header>
        <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

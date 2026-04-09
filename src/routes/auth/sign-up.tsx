import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/auth/sign-up")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <main className="flex-1 flex flex-col items-center justify-center gap-4 p-4">
      <header className="flex flex-col justify-center items-center gap-2">
        <h1 className="font-extrabold text-2xl">Sign Up</h1>
      </header>

      <p className="max-w-md text-center text-sm text-muted-foreground">
        New Google sign-ups are disabled. If you already have access, use the
        sign-in page.
      </p>

      <p className="text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link to="/auth/sign-in" className="text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </main>
  );
}

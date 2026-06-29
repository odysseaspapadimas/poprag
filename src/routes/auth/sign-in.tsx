import { createFileRoute, Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { authClient } from "@/auth/client";
import { normalizeAuthRedirect } from "@/auth/redirect";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/auth/sign-in")({
  validateSearch: (search): { redirect?: string } => {
    const redirect = normalizeAuthRedirect(search.redirect);
    return redirect === "/" ? {} : { redirect };
  },
  component: RouteComponent,
});

function RouteComponent() {
  const { redirect = "/" } = Route.useSearch();

  const handleGoogleSignIn = async () => {
    try {
      await authClient.signIn.social({
        provider: "google",
        callbackURL: redirect,
      });
      // The redirect will happen automatically
    } catch (error) {
      toast.error("Failed to sign in with Google");
    }
  };

  return (
    <main className="flex-1 flex flex-col items-center justify-center gap-4 p-4">
      <header className="flex flex-col justify-center items-center gap-2">
        <h1 className="font-extrabold text-2xl">Sign In</h1>
      </header>

      <div className="w-full max-w-md space-y-4">
        <Button
          onClick={handleGoogleSignIn}
          className="w-full"
          variant="outline"
        >
          Sign in with Google
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">
        Need staging access?{" "}
        <Link
          to="/auth/sign-up"
          search={{ redirect }}
          className="text-primary hover:underline"
        >
          Create an account
        </Link>
      </p>
    </main>
  );
}

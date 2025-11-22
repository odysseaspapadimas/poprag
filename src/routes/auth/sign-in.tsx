import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { authClient } from "@/auth/client";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/auth/sign-in")({
  component: RouteComponent,
});

function RouteComponent() {
  const navigate = useNavigate();

  const handleGoogleSignIn = async () => {
    try {
      await authClient.signIn.social({
        provider: "google",
        callbackURL: "/",
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
        Don't have an account?{" "}
        <Link to="/auth/sign-up" className="text-primary hover:underline">
          Sign up
        </Link>
      </p>
    </main>
  );
}

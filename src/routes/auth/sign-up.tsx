import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { normalizeAuthRedirect } from "@/auth/redirect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTRPC } from "@/integrations/trpc/react";

export const Route = createFileRoute("/auth/sign-up")({
  validateSearch: (search): { redirect?: string } => {
    const redirect = normalizeAuthRedirect(search.redirect);
    return redirect === "/" ? {} : { redirect };
  },
  component: RouteComponent,
});

function RouteComponent() {
  const trpc = useTRPC();
  const { redirect = "/" } = Route.useSearch();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const signUpMutation = useMutation(
    trpc.auth.signUp.mutationOptions({
      onSuccess: () => {
        toast.success("Account created. You are signed in as an admin.");
        window.location.assign(redirect);
      },
      onError: (error) => {
        toast.error(error.message || "Failed to sign up");
      },
    }),
  );

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    signUpMutation.mutate({ name, email, password });
  };

  return (
    <main className="flex-1 flex flex-col items-center justify-center gap-4 p-4">
      <header className="flex flex-col justify-center items-center gap-2">
        <h1 className="font-extrabold text-2xl">Sign Up</h1>
        <p className="max-w-md text-center text-sm text-muted-foreground">
          Staging sign-ups are enabled. New accounts are automatically granted
          admin access.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="w-full max-w-md space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            autoComplete="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            minLength={6}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>

        <Button
          type="submit"
          className="w-full"
          disabled={signUpMutation.isPending}
        >
          {signUpMutation.isPending ? "Creating account..." : "Create account"}
        </Button>
      </form>

      <p className="text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link
          to="/auth/sign-in"
          search={{ redirect }}
          className="text-primary hover:underline"
        >
          Sign in
        </Link>
      </p>
    </main>
  );
}

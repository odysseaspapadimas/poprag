import { type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import { AlertCircle, Home, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function DefaultCatchBoundary({ error, reset }: ErrorComponentProps) {
  console.error(error);
  const router = useRouter();

  const isDev = import.meta.env.DEV;
  const errorMessage = error instanceof Error ? error.message : "Unknown error";
  const errorStack = error instanceof Error ? error.stack : undefined;

  return (
    <div className="flex items-center justify-center min-h-screen p-4 bg-background">
      <Card className="w-full max-w-2xl border-destructive/50">
        <CardHeader>
          <div className="flex items-center gap-2">
            <AlertCircle className="h-6 w-6 text-destructive" />
            <CardTitle className="text-2xl">Something went wrong</CardTitle>
          </div>
          <CardDescription>
            An unexpected error occurred. Please try again or contact support if
            the problem persists.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isDev && (
            <div className="space-y-2">
              <h3 className="font-semibold text-sm text-muted-foreground">
                Error Details (Development Only)
              </h3>
              <div className="rounded-md bg-muted p-4">
                <p className="font-mono text-sm text-destructive break-all">
                  {errorMessage}
                </p>
                {errorStack && (
                  <pre className="mt-4 text-xs text-muted-foreground overflow-x-auto whitespace-pre-wrap">
                    {errorStack}
                  </pre>
                )}
              </div>
            </div>
          )}
          {!isDev && (
            <div className="rounded-md bg-muted p-4">
              <p className="text-sm text-muted-foreground">
                Error ID: {Date.now().toString(36)}
              </p>
            </div>
          )}
        </CardContent>
        <CardFooter className="flex gap-2">
          <Button
            onClick={() => {
              reset?.();
              router.invalidate();
            }}
            variant="default"
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Try Again
          </Button>
          <Button
            onClick={() => router.navigate({ to: "/" })}
            variant="outline"
          >
            <Home className="mr-2 h-4 w-4" />
            Go Home
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}

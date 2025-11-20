import { QueryCache, QueryClient } from "@tanstack/react-query";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import {
  createTRPCClient,
  httpBatchLink,
  httpBatchStreamLink,
  loggerLink,
  splitLink,
  type TRPCClientErrorLike,
} from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import superjson from "superjson";
import { TRPCProvider } from "@/integrations/trpc/react";
import type { AppRouter } from "@/integrations/trpc/router";

function getUrl() {
  if (typeof window !== "undefined") {
    // Client-side: always use relative URL
    return "/api/trpc";
  }

  // Server-side: use relative URL in production/Workers, absolute in local dev
  // In Cloudflare Workers, relative URLs work for internal fetch
  // In local dev with Vite, we need absolute localhost URL
  const isDev = process.env.NODE_ENV === "development";

  if (isDev) {
    // Local development: Vite dev server on port 3000
    return "http://localhost:3000/api/trpc";
  }

  // Production/Cloudflare Workers: use relative URL for same-worker routing
  return "/api/trpc";
}

const headers = createIsomorphicFn()
  .client(() => ({}))
  .server(() => getRequestHeaders());

export const trpcClient = createTRPCClient<AppRouter>({
  links: [
    loggerLink({
      enabled: (op) =>
        process.env.NODE_ENV === "development" ||
        (op.direction === "down" && op.result instanceof Error),
    }),
    splitLink({
      condition(op) {
        // Route auth.* operations to the non-streaming httpBatchLink
        return op.path.startsWith("auth.");
      },
      true: httpBatchLink({
        transformer: superjson,
        url: getUrl(),
        headers,
      }),
      false: httpBatchStreamLink({
        transformer: superjson,
        url: getUrl(),
        headers,
      }),
    }),
  ],
});

const FIVE_MINUTES_CACHE = 5 * 60 * 1000;

const createQueryClient = () => {
  return new QueryClient({
    defaultOptions: {
      dehydrate: { serializeData: superjson.serialize },
      hydrate: { deserializeData: superjson.deserialize },
      queries: {
        staleTime: FIVE_MINUTES_CACHE,
        gcTime: FIVE_MINUTES_CACHE,
        retry(failureCount, _err) {
          const err = _err as unknown as TRPCClientErrorLike<AppRouter>;
          const code = err?.data?.code;
          if (
            code === "BAD_REQUEST" ||
            code === "FORBIDDEN" ||
            code === "UNAUTHORIZED"
          ) {
            return false;
          }
          const MAX_QUERY_RETRIES = 0;
          return failureCount < MAX_QUERY_RETRIES;
        },
      },
    },
    queryCache: new QueryCache(),
  });
};

export const createServerHelpers = ({
  queryClient,
}: {
  queryClient: QueryClient;
}) => {
  const serverHelpers = createTRPCOptionsProxy({
    client: trpcClient,
    queryClient: queryClient,
  });
  return serverHelpers;
};

export function getContext() {
  const queryClient = createQueryClient();

  const serverHelpers = createTRPCOptionsProxy({
    client: trpcClient,
    queryClient: queryClient,
  });
  return {
    queryClient,
    trpc: serverHelpers,
  };
}

export function Provider({
  children,
  queryClient,
}: {
  children: React.ReactNode;
  queryClient: QueryClient;
}) {
  return (
    <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
      {children}
    </TRPCProvider>
  );
}

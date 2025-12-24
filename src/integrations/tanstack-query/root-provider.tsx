import { TRPCProvider } from "@/integrations/trpc/react";
import type { AppRouter } from "@/integrations/trpc/router";
import { QueryCache, QueryClient } from "@tanstack/react-query";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeaders, getRequestUrl } from "@tanstack/react-start/server";
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

const getUrl = createIsomorphicFn()
  .client(() => {
    // Client-side: always use relative URL
    return "/api/trpc";
  })
  .server(() => {
    // Server-side: get the full URL from the incoming request
    // This works in both local dev and Cloudflare Workers production
    const requestUrl = getRequestUrl();
    return `${requestUrl.origin}/api/trpc`;
  });

const headers = createIsomorphicFn()
  .client(() => ({}))
  .server(() => getRequestHeaders());

// Factory function to create tRPC client - called during request time
function createTrpcClient() {
  const url = getUrl();

  return createTRPCClient<AppRouter>({
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
          url,
          headers,
        }),
        false: httpBatchStreamLink({
          transformer: superjson,
          url,
          headers,
        }),
      }),
    ],
  });
}

// Singleton for client-side, recreated for each request server-side
let clientSideTrpcClient: ReturnType<typeof createTrpcClient> | null = null;

function getTrpcClient() {
  // On the server, always create a fresh client per request
  if (typeof window === "undefined") {
    return createTrpcClient();
  }

  // On the client, reuse the same client instance
  if (!clientSideTrpcClient) {
    clientSideTrpcClient = createTrpcClient();
  }
  return clientSideTrpcClient;
}

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
    client: getTrpcClient(),
    queryClient: queryClient,
  });
  return serverHelpers;
};

export function getContext() {
  const queryClient = createQueryClient();
  const trpcClient = getTrpcClient();

  const serverHelpers = createTRPCOptionsProxy({
    client: trpcClient,
    queryClient: queryClient,
  });
  return {
    queryClient,
    trpc: serverHelpers,
    trpcClient, // Expose for Provider
  };
}

export function Provider({
  children,
  queryClient,
  trpcClient,
}: {
  children: React.ReactNode;
  queryClient: QueryClient;
  trpcClient: ReturnType<typeof getTrpcClient>;
}) {
  return (
    <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
      {children}
    </TRPCProvider>
  );
}

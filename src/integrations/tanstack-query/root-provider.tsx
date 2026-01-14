import { TRPCProvider } from "@/integrations/trpc/react";
import type { AppRouter } from "@/integrations/trpc/router";
import { QueryCache, QueryClient } from "@tanstack/react-query";
import { createIsomorphicFn } from "@tanstack/react-start";
import {
  getRequestHeaders,
  getRequestUrl,
} from "@tanstack/react-start/server";
import {
  createTRPCClient,
  httpBatchLink,
  httpBatchStreamLink,
  loggerLink,
  splitLink,
  TRPCClientError,
  type TRPCClientErrorLike,
  type TRPCLink,
} from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import superjson from "superjson";

// Get URL - uses createIsomorphicFn for proper server/client code splitting
const getUrl = createIsomorphicFn()
  .client(() => "/api/trpc")
  .server(() => {
    const requestUrl = getRequestUrl();
    return `${requestUrl.origin}/api/trpc`;
  });

// Get headers - uses createIsomorphicFn for proper server/client code splitting
const getHeaders = createIsomorphicFn()
  .client(() => ({}) as Record<string, string>)
  .server(() => getRequestHeaders() as unknown as Record<string, string>);

// Create a custom link for server-side that calls procedures directly
// This avoids HTTP loopback which can fail on Cloudflare Workers
const createServerDirectLink = createIsomorphicFn()
  .server((): TRPCLink<AppRouter> => {
    return () => {
      return ({ op }) => {
        return observable((observer) => {
          const { path, input } = op;
          
          (async () => {
            try {
              // Dynamic imports ensure server code stays out of client bundle
              const [{ createServerSideContext }, { createCaller }] = await Promise.all([
                import("@/integrations/trpc/init"),
                import("@/integrations/trpc/router"),
              ]);
              
              const headers = getHeaders();
              const ctx = await createServerSideContext(new Headers(headers));
              const caller = createCaller(ctx);
              
              // Navigate to the procedure using typed path traversal
              const pathParts = path.split(".");
              let procedure: unknown = caller;
              for (const part of pathParts) {
                procedure = (procedure as Record<string, unknown>)[part];
              }
              
              // Call the procedure as a function
              const result = await (procedure as CallableFunction)(input);
              
              observer.next({
                result: {
                  data: result,
                },
              });
              observer.complete();
            } catch (error) {
              observer.error(TRPCClientError.from(error as Error));
            }
          })();
        });
      };
    };
  });

// Factory function to create tRPC client - uses isomorphic function to split server/client code
const createTrpcClient = createIsomorphicFn()
  .client(() => {
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
            url: "/api/trpc",
            headers: getHeaders,
          }),
          false: httpBatchStreamLink({
            transformer: superjson,
            url: "/api/trpc",
            headers: getHeaders,
          }),
        }),
      ],
    });
  })
  .server(() => {
    const url = getUrl();
    const serverLink = createServerDirectLink();
    
    // If server direct link is available, use it (avoids HTTP loopback on Cloudflare)
    if (serverLink) {
      return createTRPCClient<AppRouter>({
        links: [
          loggerLink({
            enabled: (op) =>
              process.env.NODE_ENV === "development" ||
              (op.direction === "down" && op.result instanceof Error),
          }),
          serverLink,
        ],
      });
    }
    
    // Fallback to HTTP if server link not available
    return createTRPCClient<AppRouter>({
      links: [
        loggerLink({
          enabled: (op) =>
            process.env.NODE_ENV === "development" ||
            (op.direction === "down" && op.result instanceof Error),
        }),
        splitLink({
          condition(op) {
            return op.path.startsWith("auth.");
          },
          true: httpBatchLink({
            transformer: superjson,
            url,
            headers: getHeaders,
          }),
          false: httpBatchStreamLink({
            transformer: superjson,
            url,
            headers: getHeaders,
          }),
        }),
      ],
    });
  });

// Singleton for client-side, recreated for each request server-side
let clientSideTrpcClient: ReturnType<typeof createTRPCClient<AppRouter>> | null = null;

function getTrpcClient() {
  // On the server, always create a fresh client per request with direct procedure calls
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

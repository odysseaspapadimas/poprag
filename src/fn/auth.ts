import type { QueryClient } from "@tanstack/react-query";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { authClient } from "@/auth/client";
import { auth } from "@/auth/server";

export const $getSession = createIsomorphicFn()
  .client(async (queryClient: QueryClient) => {
    const { data: session } = await queryClient.ensureQueryData({
      queryFn: () => authClient.getSession(),
      queryKey: ["auth", "getSession"],
      staleTime: 60_000, // cache for 1 minute
      revalidateIfStale: true, // fetch in background when stale
    });

    return {
      session,
    };
  })
  .server(async (_: QueryClient) => {
    const headers = getRequestHeaders();
    if (!headers) {
      return { session: null };
    }

    const session = await auth.api.getSession({
      headers,
    });

    return {
      session,
    };
  });

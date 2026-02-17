import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";

import { auth } from "@/auth/server";
import { db } from "@/db";

export const createTRPCContext = async ({
  request,
  resHeaders,
}: {
  request: Request;
  resHeaders: Headers;
}) => {
  const headers = request.headers;
  const session = await auth.api.getSession({
    headers,
  });

  return {
    request,
    db,
    session,
    responseHeaders: resHeaders,
  };
};

// Context for server-side calls (no full request/response needed)
export const createServerSideContext = async (
  headers?: Headers,
  url?: string,
) => {
  const reqHeaders = headers ?? new Headers();
  const session = headers ? await auth.api.getSession({ headers }) : null;

  return {
    request: new Request(url ?? "http://localhost", { headers: reqHeaders }),
    db,
    session,
    responseHeaders: new Headers(),
  };
};

export const t = initTRPC.context<typeof createTRPCContext>().create({
  transformer: superjson,
});

export const createTRPCRouter = t.router;
export const createCallerFactory = t.createCallerFactory;

const enforceUserIsAuthenticated = t.middleware(({ ctx, next }) => {
  if (!ctx.session?.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }

  return next({
    ctx: {
      session: { ...ctx.session, user: ctx.session.user },
    },
  });
});

export const publicProcedure = t.procedure;
export const protectedProcedure = t.procedure.use(enforceUserIsAuthenticated);
export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (!ctx.session.user.isAdmin) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Admin access required",
    });
  }

  return next({
    ctx: {
      session: { ...ctx.session, user: ctx.session.user },
    },
  });
});

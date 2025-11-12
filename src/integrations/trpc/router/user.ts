import type { TRPCRouterRecord } from "@trpc/server";

import { protectedProcedure } from "@/integrations/trpc/init";

export const userRouter = {
  getAll: protectedProcedure.query(
    async ({ ctx }) => await ctx.db.query.user.findMany(),
  ),
} satisfies TRPCRouterRecord;

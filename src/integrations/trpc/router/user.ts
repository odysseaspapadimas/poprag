import type { TRPCRouterRecord } from "@trpc/server";

import { adminProcedure } from "@/integrations/trpc/init";

export const userRouter = {
  getAll: adminProcedure.query(
    async ({ ctx }) => await ctx.db.query.user.findMany(),
  ),
} satisfies TRPCRouterRecord;

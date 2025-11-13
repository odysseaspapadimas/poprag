import { db } from "@/db";
import { modelAlias } from "@/db/schema";
import { createTRPCRouter, publicProcedure } from "@/integrations/trpc/init";

export const modelRouter = createTRPCRouter({
  list: publicProcedure.query(async () => {
    return await db.select().from(modelAlias);
  }),
});
import { createTRPCRouter } from "@/integrations/trpc/init";
import { userRouter } from "@/integrations/trpc/router/user";
import { authRouter } from "./auth";

export const appRouter = createTRPCRouter({
  user: userRouter,
  auth: authRouter,
});

export type AppRouter = typeof appRouter;

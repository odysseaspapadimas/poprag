import { createTRPCRouter } from "@/integrations/trpc/init";
import { userRouter } from "@/integrations/trpc/router/user";
import { agentRouter } from "./agent";
import { authRouter } from "./auth";
import { knowledgeRouter } from "./knowledge";
import { modelRouter } from "./model";
import { promptRouter } from "./prompt";

export const appRouter = createTRPCRouter({
  user: userRouter,
  auth: authRouter,
  agent: agentRouter,
  prompt: promptRouter,
  knowledge: knowledgeRouter,
  model: modelRouter,
});

export type AppRouter = typeof appRouter;

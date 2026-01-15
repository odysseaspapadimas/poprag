import {
  createCallerFactory,
  createTRPCRouter,
} from "@/integrations/trpc/init";
import { userRouter } from "@/integrations/trpc/router/user";
import { agentRouter } from "./agent";
import { authRouter } from "./auth";
import { chatRouter } from "./chat";
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
  chat: chatRouter,
});

export type AppRouter = typeof appRouter;

// Create a server-side caller factory for direct procedure invocation
export const createCaller = createCallerFactory(appRouter);

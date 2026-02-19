import {
  createStartHandler,
  defaultStreamHandler,
} from "@tanstack/react-start/server";
import {
  handleKnowledgeIndexQueue,
  type KnowledgeIndexMessage,
} from "@/lib/ai/queue-consumer";

const fetch = createStartHandler(defaultStreamHandler);

export default {
  fetch,
  async queue(
    batch: MessageBatch<KnowledgeIndexMessage>,
    env: Env,
    _ctx: ExecutionContext,
  ) {
    await handleKnowledgeIndexQueue(batch, env);
  },
};

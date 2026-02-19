import handler from "@tanstack/react-start/server-entry";
import {
  handleKnowledgeIndexQueue,
  type KnowledgeIndexMessage,
} from "@/lib/ai/queue-consumer";

export default {
  fetch: handler.fetch,
  async queue(
    batch: MessageBatch<KnowledgeIndexMessage>,
    env: Env,
    _ctx: ExecutionContext,
  ) {
    await handleKnowledgeIndexQueue(batch, env);
  },
};

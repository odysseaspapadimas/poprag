import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import handler from "@tanstack/react-start/server-entry";
import {
  handleKnowledgeIndexQueue,
  type KnowledgeIndexMessage,
} from "@/lib/ai/queue-consumer";
import {
  type CatalogSyncWorkflowParams,
  runCatalogSyncWorkflow,
} from "@/lib/catalog/sync";

export class CatalogSyncWorkflow extends WorkflowEntrypoint<
  Env,
  CatalogSyncWorkflowParams | undefined
> {
  async run(
    event: Readonly<WorkflowEvent<CatalogSyncWorkflowParams | undefined>>,
    step: WorkflowStep,
  ) {
    const params = event.payload ?? {};
    const target = params.configId
      ? `config ${params.configId}`
      : "due configs";

    return await step.do(
      `Run catalog sync for ${target}`,
      {
        retries: { limit: 2, delay: "30 seconds", backoff: "exponential" },
        timeout: "15 minutes",
      },
      () => runCatalogSyncWorkflow(params, this.env, event.instanceId),
    );
  }
}

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

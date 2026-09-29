import { finalizeEvent } from "nostr-tools";
import type { WingmanInstanceIdentity } from "../identity/wingman-instance-identity";
import type { PipelineApiContext } from "./pipeline-api-routes";
import { resumeRunningPipelineRuns } from "./pipeline-api-routes";
import { ResultWebhookService } from "./result-webhook-service";

export function startPublicPipelineRuntime(ctx: PipelineApiContext, identity: WingmanInstanceIdentity | null,
  log: (error: unknown) => void): ResultWebhookService | undefined {
  const service = identity ? new ResultWebhookService(ctx.store, identity.pubkeyHex,
    event => finalizeEvent(event, identity.secretKey), undefined, undefined, log) : undefined;
  service?.start();
  void resumeRunningPipelineRuns(ctx, ctx.callbackOrigin!).catch(log);
  return service;
}

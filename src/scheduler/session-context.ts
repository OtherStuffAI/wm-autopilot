import { z } from "zod";
import type { SessionMetadataInput } from "../sessions/session-metadata";
import type { WorkspaceSubscriptionRecord } from "../agent-chat/types";
import type { FlightDeckTransportBinding } from "../agent-chat/flightdeck-session-transport";
import type { ScheduledJob } from "./scheduler-store";

const id = z.string().uuid();
/** An exact transport binding; workspace-only bindings support private messaging. */
export const scheduledSessionContextSchema = z.object({
  ownerNpub: z.string().min(1),
  subscriptionId: id,
  workspaceId: id,
  scopeId: id.optional(),
  channelId: id.optional(),
  threadId: id.optional(),
  taskId: id.optional(),
}).strict().refine(value => !value.threadId || Boolean(value.channelId), {
  message: "A scheduled thread requires its channel",
}).refine(value => !value.taskId || Boolean(value.channelId && value.scopeId), {
  message: "A scheduled task requires its scope and channel",
});
export type ScheduledSessionContext = z.infer<typeof scheduledSessionContextSchema>;

export function buildScheduledSessionContextMetadata(
  job: Pick<ScheduledJob, "userNpub" | "botNpub">,
  value: unknown,
  subscription: WorkspaceSubscriptionRecord | null,
): NonNullable<SessionMetadataInput> {
  const context = scheduledSessionContextSchema.parse(value);
  if (context.ownerNpub !== job.userNpub || !subscription
    || subscription.subscriptionId !== context.subscriptionId
    || subscription.workspaceId !== context.workspaceId
    || subscription.managedByNpub !== job.userNpub || subscription.botNpub !== job.botNpub
    || subscription.lifecycleStatus !== "active" || subscription.sseStatus === "disabled") {
    throw new Error("Scheduled Flight Deck binding requires the exact active owner, bot, subscription and workspace.");
  }
  if (!subscription.towerServiceNpub || !subscription.backendConnectionId
    || !subscription.sourceAppNpub || !z.string().url().safeParse(subscription.backendBaseUrl).success) {
    throw new Error("Scheduled Flight Deck binding requires Tower service identity, backend connection, URL and app identity.");
  }
  return {
    flightdeckSubscriptionId: subscription.subscriptionId,
    flightdeckTowerServiceNpub: subscription.towerServiceNpub,
    flightdeckBackendConnectionId: subscription.backendConnectionId,
    flightdeckWorkspaceId: context.workspaceId,
    flightdeckAgentNpub: job.botNpub,
    flightdeckScopeId: context.scopeId,
    flightdeckChannelId: context.channelId,
    flightdeckThreadId: context.threadId,
    ...(context.taskId ? { bindingType: "task", bindingId: context.taskId } : {}),
  };
}

/** Validate before session creation; never guess a workspace from an owner or bot. */
export function createScheduledSessionContextResolver(deps: {
  getSubscription: (id: string) => WorkspaceSubscriptionRecord | null;
  resolveTransport?: (binding: FlightDeckTransportBinding) => { subscriptionId: string; backendBaseUrl: string; appNpub: string } | null;
  getActiveBotOwnerNpub: (botNpub: string) => string | null;
}): (job: Pick<ScheduledJob, "userNpub" | "botNpub" | "flightdeckContext">) => SessionMetadataInput {
  return (job) => {
    if (deps.getActiveBotOwnerNpub(job.botNpub) !== job.userNpub) {
      throw new Error("Scheduled trigger requires its exact active bot owned by the scheduler owner.");
    }
    if (!job.flightdeckContext) return {};
    const metadata = buildScheduledSessionContextMetadata(job, job.flightdeckContext,
      deps.getSubscription(job.flightdeckContext.subscriptionId));
    if (deps.resolveTransport) {
      const transport = deps.resolveTransport({
        towerServiceNpub: metadata.flightdeckTowerServiceNpub!, workspaceId: metadata.flightdeckWorkspaceId!,
        agentNpub: job.botNpub, managerNpub: job.userNpub,
        subscriptionId: metadata.flightdeckSubscriptionId, backendConnectionId: metadata.flightdeckBackendConnectionId,
      });
      if (!transport) throw new Error("Scheduled Flight Deck subscription has no exact live bot transport.");
    }
    return metadata;
  };
}

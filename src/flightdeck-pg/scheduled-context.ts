import { z } from "zod";
import { buildFlightDeckSessionMetadata } from "../agent-chat/flightdeck-session-metadata.ts";
import type { WorkspaceSubscriptionRecord } from "../agent-chat/types.ts";

const id = z.string().uuid();
export const scheduledContextSchema = z.object({
  ownerNpub: z.string().min(1),
  subscriptionId: id,
  workspaceId: id,
  scopeId: id,
  channelId: id,
  threadId: id,
  taskId: id,
}).strict();
export type ScheduledContext = z.infer<typeof scheduledContextSchema>;
type RecordValue = Record<string, any>;
type RequestJson = (method: string, path: string, body?: unknown) => Promise<RecordValue>;
const subscriptionTransportSchema = z.object({
  subscriptionId: id,
  workspaceId: id,
  managedByNpub: z.string().min(1),
  botNpub: z.string().min(1),
  lifecycleStatus: z.literal("active"),
  towerServiceNpub: z.string().min(1),
  backendConnectionId: z.string().min(1),
  backendBaseUrl: z.string().url(),
  sourceAppNpub: z.string().min(1),
});

/** Bind only the calling scheduled session through existing authenticated APIs. */
export async function bindScheduledFlightDeckContext(input: {
  sessionId: string;
  config: ScheduledContext;
  request: RequestJson;
  context: () => Promise<RecordValue>;
}): Promise<RecordValue> {
  const config = scheduledContextSchema.parse(input.config);
  const sessionPath = `/api/sessions/${encodeURIComponent(input.sessionId)}`;
  const session = await input.request("GET", sessionPath);
  if (session.id !== input.sessionId || session.npub !== config.ownerNpub
    || session.origin?.type !== "scheduler" || !session.origin.id
    || ["stopped", "error"].includes(session.status)) {
    throw new Error("Binding requires the caller's active scheduled session and exact owner.");
  }
  const ownerPath = `/api/owners/${encodeURIComponent(config.ownerNpub)}`;
  const { jobs } = await input.request("GET", `${ownerPath}/scheduler/jobs`);
  const job = Array.isArray(jobs) ? jobs.find(row => row.id === session.origin.id) : null;
  const botNpub = session.metadata?.agentChatBotNpub;
  if (!job || !job.enabled || job.actionType !== "session" || job.userNpub !== config.ownerNpub
    || !botNpub || job.botNpub !== botNpub || job.agent !== session.agent
    || job.workingDirectory !== session.workingDirectory) {
    throw new Error("Scheduled session no longer matches its enabled trigger, owner, bot or directory.");
  }
  const { subscription } = await input.request("GET", `/api/agent-chat/subscriptions/${config.subscriptionId}`);
  if (!subscription || subscription.subscriptionId !== config.subscriptionId
    || subscription.workspaceId !== config.workspaceId || subscription.managedByNpub !== config.ownerNpub
    || subscription.botNpub !== botNpub || subscription.lifecycleStatus !== "active") {
    throw new Error("Scheduled Flight Deck subscription is missing, inactive or belongs to another owner, bot or workspace.");
  }
  const transport = subscriptionTransportSchema.safeParse(subscription);
  if (!transport.success) {
    throw new Error("Scheduled Flight Deck subscription requires Tower service identity, backend connection, URL and app identity.");
  }
  const metadata = {
    ...buildFlightDeckSessionMetadata(subscription as WorkspaceSubscriptionRecord, botNpub, config),
    bindingType: "task",
    bindingId: config.taskId,
  };
  for (const [key, value] of Object.entries(metadata)) {
    const existing = session.metadata?.[key];
    if (existing != null && existing !== value) {
      throw new Error(`Scheduled session already has a conflicting ${key} binding.`);
    }
  }
  await input.request("PATCH", `${sessionPath}/metadata`, { metadata });
  const readback = await input.request("GET", `${sessionPath}/metadata`);
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined && readback.metadata?.[key] !== value) {
      throw new Error(`Scheduled context metadata readback did not match ${key}.`);
    }
  }
  const context = await input.context();
  if (context.workspace?.workspaceId !== config.workspaceId
    || context.workspace?.subscriptionId !== config.subscriptionId
    || context.workspace?.backendBaseUrl !== subscription.backendBaseUrl
    || context.workspace?.sourceAppNpub !== subscription.sourceAppNpub
    || context.bot?.npub !== botNpub || context.bot?.available !== true
    || context.chat?.channelId !== config.channelId || context.chat?.threadId !== config.threadId
    || context.routing?.bindingType !== "task" || context.record?.recordId !== config.taskId) {
    throw new Error("Live broker did not resolve the exact scheduled Flight Deck context.");
  }
  return context;
}

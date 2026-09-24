import type { AgentDefinitionStore } from "../agent-chat/agent-definition-store";
import type { WorkspaceSubscriptionStore } from "../agent-chat/workspace-subscription-store";
import {
  createFlightDeckPgChannelMessage,
  fetchFlightDeckPgChannelMessages,
  fetchFlightDeckPgScopeChannels,
  fetchFlightDeckPgWorkspaceScopes,
  type FlightDeckPgBotIdentity,
  type FlightDeckPgChannel,
  type FlightDeckPgMessage,
} from "../agent-chat/tower-client";
import type { AgentDefinitionRecord, WorkspaceSubscriptionRecord } from "../agent-chat/types";
import type {
  FlightDeckInvocationResolution,
  FlightDeckPipelineInvocation,
  FlightDeckThreadSender,
} from "./flightdeck-invocation";

interface ThreadRuntimeDependencies {
  agentStore: Pick<AgentDefinitionStore, "getByBotNpub"> & Partial<Pick<AgentDefinitionStore, "getDefaultForManagerNpub">>;
  subscriptionStore: Pick<WorkspaceSubscriptionStore, "listAll">;
  withAgentIdentity: <T>(agent: AgentDefinitionRecord, operation: (identity: FlightDeckPgBotIdentity) => Promise<T>) => Promise<T>;
  fetchScopes?: typeof fetchFlightDeckPgWorkspaceScopes;
  fetchChannels?: typeof fetchFlightDeckPgScopeChannels;
  fetchMessages?: typeof fetchFlightDeckPgChannelMessages;
  createMessage?: typeof createFlightDeckPgChannelMessage;
}

export function createFlightDeckThreadRuntime(deps: ThreadRuntimeDependencies): {
  resolve: (input: FlightDeckPipelineInvocation, ownerNpub?: string | null) => Promise<FlightDeckInvocationResolution>;
  send: FlightDeckThreadSender;
} {
  const resolve = async (input: FlightDeckPipelineInvocation, ownerNpub?: string | null) => {
    const selected = selectManagedSubscription(deps, input.workspaceId, ownerNpub);
    const agent = deps.agentStore.getByBotNpub(selected.botNpub);
    if (!agent || !agent.enabled || agent.archived) {
      throw new Error(`Workspace ${input.workspaceId} has no active managed agent identity`);
    }
    return await deps.withAgentIdentity(agent, async (botIdentity) => {
      if (botIdentity.botNpub !== selected.botNpub) {
        throw new Error("Resolved managed agent identity does not match the workspace subscription");
      }
      const channel = await resolveThreadChannel(deps, selected, botIdentity, input.threadId);
      return {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        channelId: channel.id,
        senderNpub: botIdentity.botNpub,
      };
    });
  };

  const send: FlightDeckThreadSender = async (input) => {
    const selected = selectManagedSubscription(deps, input.workspaceId, null);
    const agent = deps.agentStore.getByBotNpub(selected.botNpub);
    if (!agent || !agent.enabled || agent.archived) {
      throw new Error(`Workspace ${input.workspaceId} has no active managed agent identity`);
    }
    return await deps.withAgentIdentity(agent, async (botIdentity) => {
      if (botIdentity.botNpub !== selected.botNpub) {
        throw new Error("Resolved managed agent identity does not match the workspace subscription");
      }
      const channel = await resolveThreadChannel(deps, selected, botIdentity, input.threadId);
      const result = await (deps.createMessage ?? createFlightDeckPgChannelMessage)({
        ...requestBase(selected, botIdentity),
        channelId: channel.id,
        threadId: input.threadId,
        body: input.message,
        metadata: {
          source: "pipeline",
          format: "markdown",
          requester_npub: input.frmNpub,
        },
      });
      const messageId = result.message?.id;
      if (!messageId) throw new Error("Tower accepted the thread response without returning a message id");
      return {
        delivered: true,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        channelId: channel.id,
        messageId,
        senderNpub: botIdentity.botNpub,
        requesterNpub: input.frmNpub,
        format: "markdown",
        signatureProtocol: "flightdeck_pg_message_instruction",
      };
    });
  };
  return { resolve, send };
}

function selectManagedSubscription(
  deps: ThreadRuntimeDependencies,
  workspaceId: string,
  ownerNpub?: string | null,
): WorkspaceSubscriptionRecord {
  const records = deps.subscriptionStore.listAll();
  const active = records.filter((record) =>
    record.workspaceId === workspaceId && (record.lifecycleStatus ?? "active") === "active"
  );
  const owned = ownerNpub ? active.filter((record) => record.managedByNpub === ownerNpub) : [];
  const candidates = owned.length > 0 ? owned : active;
  const managers = [...new Set(candidates.map((record) => record.managedByNpub).filter((value): value is string => Boolean(value)))];
  const defaultAgent = managers.length === 1 ? deps.agentStore.getDefaultForManagerNpub?.(managers[0]!) : null;
  const defaultCandidates = defaultAgent ? candidates.filter((record) => record.botNpub === defaultAgent.botNpub) : [];
  if (defaultCandidates.length === 1) return defaultCandidates[0]!;
  if (candidates.length !== 1) {
    throw new Error(candidates.length === 0
      ? `No active managed-agent subscription resolves workspace ${workspaceId}`
      : `Workspace ${workspaceId} resolves to multiple managed-agent subscriptions`);
  }
  return candidates[0]!;
}

async function resolveThreadChannel(
  deps: ThreadRuntimeDependencies,
  subscription: WorkspaceSubscriptionRecord,
  botIdentity: FlightDeckPgBotIdentity,
  threadId: string,
): Promise<FlightDeckPgChannel> {
  const base = requestBase(subscription, botIdentity);
  const scopes = (await (deps.fetchScopes ?? fetchFlightDeckPgWorkspaceScopes)(base)).scopes;
  const channels: FlightDeckPgChannel[] = [];
  for (const scope of scopes) {
    const result = await (deps.fetchChannels ?? fetchFlightDeckPgScopeChannels)({ ...base, scopeId: scope.id, limit: 200 });
    channels.push(...result.channels);
  }
  for (const channel of uniqueChannels(channels)) {
    let result;
    try {
      result = await (deps.fetchMessages ?? fetchFlightDeckPgChannelMessages)({
        ...base,
        channelId: channel.id,
        threadId,
        effectiveTranscript: true,
        limit: 200,
      });
    } catch (error) {
      if (isThreadMissingFromChannel(error)) continue;
      throw error;
    }
    if (result.messages.some((message) => belongsToThread(message, threadId))) return channel;
  }
  throw new Error(`Thread ${threadId} was not found in workspace ${subscription.workspaceId}`);
}

function isThreadMissingFromChannel(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const towerError = error as { status?: unknown; detailCode?: unknown };
  return towerError.status === 404 && towerError.detailCode === "thread_not_found";
}

function requestBase(subscription: WorkspaceSubscriptionRecord, botIdentity: FlightDeckPgBotIdentity) {
  return {
    backendConnectionId: subscription.backendConnectionId,
    subscriptionId: subscription.subscriptionId,
    backendBaseUrl: subscription.backendBaseUrl,
    workspaceId: subscription.workspaceId!,
    appNpub: subscription.sourceAppNpub,
    botIdentity,
  };
}

function uniqueChannels(channels: FlightDeckPgChannel[]): FlightDeckPgChannel[] {
  return [...new Map(channels.map((channel) => [channel.id, channel])).values()];
}

function belongsToThread(message: FlightDeckPgMessage, threadId: string): boolean {
  return [message.id, message.thread_id, message.thread_source_message_id, message.owning_thread_id, message.effective_thread_id]
    .includes(threadId);
}

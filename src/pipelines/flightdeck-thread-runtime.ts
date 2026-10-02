import type { AgentDefinitionStore } from "../agent-chat/agent-definition-store";
import type { AgentProfilePolicyStore } from "../agent-chat/agent-profile-policy-store";
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
  profileStore?: Pick<AgentProfilePolicyStore, "listWorkspacesForProfile">;
  subscriptionStore: Pick<WorkspaceSubscriptionStore, "listAll">;
  withAgentIdentity: <T>(agent: AgentDefinitionRecord, operation: (identity: FlightDeckPgBotIdentity) => Promise<T>) => Promise<T>;
  fetchScopes?: typeof fetchFlightDeckPgWorkspaceScopes;
  fetchChannels?: typeof fetchFlightDeckPgScopeChannels;
  fetchMessages?: typeof fetchFlightDeckPgChannelMessages;
  createMessage?: typeof createFlightDeckPgChannelMessage;
  resolveTrustedAgentNpub?: (runId: string) => string | null;
}

export function createFlightDeckThreadRuntime(deps: ThreadRuntimeDependencies): {
  resolve: (input: FlightDeckPipelineInvocation, ownerNpub?: string | null, initiatingAgentNpub?: string | null) => Promise<FlightDeckInvocationResolution>;
  send: FlightDeckThreadSender;
} {
  const resolve = async (input: FlightDeckPipelineInvocation, ownerNpub?: string | null, initiatingAgentNpub?: string | null) => {
    const selected = selectManagedSubscription(deps, input.workspaceId, ownerNpub, initiatingAgentNpub);
    const senderNpub = initiatingAgentNpub ?? selected.botNpub;
    const agent = deps.agentStore.getByBotNpub(senderNpub);
    if (ownerNpub && agent?.managedByNpub !== ownerNpub) throw new Error("Resolved agent manager differs from requested owner");
    if (!agent || !agent.enabled || agent.archived) {
      throw new Error(`Workspace ${input.workspaceId} has no active managed agent identity`);
    }
    return await deps.withAgentIdentity(agent, async (botIdentity) => {
      if (botIdentity.botNpub !== senderNpub) {
        throw new Error("Resolved managed agent identity does not match the workspace subscription");
      }
      const channel = await resolveThreadChannel(deps, selected, botIdentity, input.threadId);
      return {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        channelId: channel.id,
        senderNpub: botIdentity.botNpub,
        towerServiceNpub: selected.towerServiceNpub ?? null,
        appNpub: selected.sourceAppNpub,
        agentProfileId: agent.agentId,
      };
    });
  };

  const send: FlightDeckThreadSender = async (input) => {
    const trustedAgentNpub = input.pipelineRunId && deps.resolveTrustedAgentNpub?.(input.pipelineRunId);
    const trustedAgent = trustedAgentNpub ? deps.agentStore.getByBotNpub(trustedAgentNpub) : null;
    const selected = selectManagedSubscription(deps, input.workspaceId, trustedAgent?.managedByNpub ?? null, trustedAgentNpub || null);
    const agent = deps.agentStore.getByBotNpub(trustedAgentNpub || selected.botNpub);
    if (!agent || !agent.enabled || agent.archived) {
      throw new Error(`Workspace ${input.workspaceId} has no active managed agent identity`);
    }
    return await deps.withAgentIdentity(agent, async (botIdentity) => {
      if (botIdentity.botNpub !== (trustedAgentNpub || selected.botNpub)) {
        throw new Error("Resolved managed agent identity does not match trusted pipeline context");
      }
      const channel = input.channelId
        ? await validateExactThreadRoute(deps, selected, botIdentity, input.scopeId, input.channelId, input.threadId)
        : await resolveThreadChannel(deps, selected, botIdentity, input.threadId);
      const result = await (deps.createMessage ?? createFlightDeckPgChannelMessage)({
        ...requestBase(selected, botIdentity),
        channelId: channel.id,
        threadId: input.threadId,
        body: input.message,
        metadata: {
          source: "pipeline",
          format: "markdown",
          ...(input.frmNpub ? { requester_npub: input.frmNpub } : {}),
        },
        clientRequestId: input.clientRequestId,
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
        requesterNpub: input.frmNpub ?? null,
        format: "markdown",
        signatureProtocol: "flightdeck_pg_message_instruction",
      };
    });
  };
  return { resolve, send };
}

async function validateExactThreadRoute(
  deps: ThreadRuntimeDependencies,
  subscription: WorkspaceSubscriptionRecord,
  botIdentity: FlightDeckPgBotIdentity,
  scopeId: string | undefined,
  channelId: string,
  threadId: string,
): Promise<FlightDeckPgChannel> {
  if (!scopeId) throw new Error("scopeId is required with an exact Flight Deck channel route");
  const base = requestBase(subscription, botIdentity);
  const channels = (await (deps.fetchChannels ?? fetchFlightDeckPgScopeChannels)({ ...base, scopeId, limit: 200 })).channels;
  const channel = channels.find((entry) => entry.id === channelId);
  if (!channel) throw new Error(`Channel ${channelId} was not found in scope ${scopeId}`);
  const result = await (deps.fetchMessages ?? fetchFlightDeckPgChannelMessages)({
    ...base, channelId, threadId, effectiveTranscript: true, limit: 200,
  });
  if (!result.messages.some((message) => belongsToThread(message, threadId))) {
    throw new Error(`Thread ${threadId} was not found in channel ${channelId}`);
  }
  return channel;
}

function selectManagedSubscription(
  deps: ThreadRuntimeDependencies,
  workspaceId: string,
  ownerNpub?: string | null,
  preferredBotNpub?: string | null,
): WorkspaceSubscriptionRecord {
  const records = deps.subscriptionStore.listAll();
  const active = records.filter((record) =>
    record.workspaceId === workspaceId && (record.lifecycleStatus ?? "active") === "active"
  );
  const owned = ownerNpub ? active.filter((record) => record.managedByNpub === ownerNpub) : [];
  if (ownerNpub && !owned.length) throw new Error(`No active requested-owner subscription resolves workspace ${workspaceId}`);
  const candidates = ownerNpub ? owned : active;
  const preferredAgent = preferredBotNpub ? deps.agentStore.getByBotNpub(preferredBotNpub) : null;
  const linkedSubscriptionIds = preferredAgent?.managedByNpub && deps.profileStore
    ? new Set(deps.profileStore.listWorkspacesForProfile(preferredAgent.agentId, preferredAgent.managedByNpub)
      .filter((workspace) => workspace.workspaceId === workspaceId)
      .map((workspace) => workspace.subscriptionId))
    : new Set<string>();
  const preferred = preferredBotNpub
    ? candidates.filter((record) => record.botNpub === preferredBotNpub || linkedSubscriptionIds.has(record.subscriptionId))
    : [];
  if (preferred.length === 1) return preferred[0]!;
  if (preferredBotNpub && preferred.length !== 1) {
    throw new Error(`Trusted agent ${preferredBotNpub} does not resolve one active subscription for workspace ${workspaceId}`);
  }
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

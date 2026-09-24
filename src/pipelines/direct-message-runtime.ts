import type { AgentDefinitionStore } from "../agent-chat/agent-definition-store";
import type { WorkspaceSubscriptionStore } from "../agent-chat/workspace-subscription-store";
import {
  createFlightDeckPgChannel,
  createFlightDeckPgChannelMessage,
  fetchFlightDeckPgScopeChannels,
  fetchFlightDeckPgWorkspaceScopes,
  type FlightDeckPgBotIdentity,
  type FlightDeckPgChannel,
} from "../agent-chat/tower-client";
import type { AgentDefinitionRecord, WorkspaceSubscriptionRecord } from "../agent-chat/types";
import type { PipelineDirectMessageSender } from "./direct-message-block";

interface DirectMessageRuntimeDependencies {
  agentStore: Pick<AgentDefinitionStore, "getByBotNpub">;
  subscriptionStore: Pick<WorkspaceSubscriptionStore, "listAll">;
  withAgentIdentity: <T>(agent: AgentDefinitionRecord, operation: (identity: FlightDeckPgBotIdentity) => Promise<T>) => Promise<T>;
}

export function createPipelineDirectMessageSender(deps: DirectMessageRuntimeDependencies): PipelineDirectMessageSender {
  return async ({ fromNpub, toNpub, message }) => {
    const agent = deps.agentStore.getByBotNpub(fromNpub);
    if (!agent || !agent.enabled || agent.archived) {
      throw new Error(`fromNpub is not an active Autopilot agent: ${fromNpub}`);
    }
    const subscription = selectSubscription(deps.subscriptionStore.listAll(), fromNpub, toNpub);
    return await deps.withAgentIdentity(agent, async (botIdentity) => {
      if (botIdentity.botNpub !== fromNpub) {
        throw new Error("Resolved agent identity does not match fromNpub");
      }
      const base = {
        backendConnectionId: subscription.backendConnectionId,
        subscriptionId: subscription.subscriptionId,
        backendBaseUrl: subscription.backendBaseUrl,
        workspaceId: subscription.workspaceId!,
        appNpub: subscription.sourceAppNpub,
        botIdentity,
      };
      const scopesResult = await fetchFlightDeckPgWorkspaceScopes(base);
      const scopes = scopesResult.scopes;
      if (scopes.length === 0) throw new Error("The selected workspace has no visible scope for direct messages");

      let channel: FlightDeckPgChannel | null = null;
      for (const scope of scopes) {
        const result = await fetchFlightDeckPgScopeChannels({ ...base, scopeId: scope.id, limit: 200 });
        channel = result.channels.find((candidate) => isExactDirectMessage(candidate, fromNpub, toNpub)) ?? null;
        if (channel) break;
      }

      let createdChannel = false;
      if (!channel) {
        const scope = [...scopes].sort((left, right) => left.id.localeCompare(right.id))[0]!;
        const created = await createFlightDeckPgChannel({
          ...base,
          scopeId: scope.id,
          name: `Direct message ${shortNpub(fromNpub)} ${shortNpub(toNpub)}`,
          kind: "dm",
          participantNpubs: [fromNpub, toNpub],
        });
        channel = created.channel ?? null;
        createdChannel = true;
      }
      if (!channel?.id) throw new Error("Tower did not return a direct-message channel");

      const delivered = await createFlightDeckPgChannelMessage({
        ...base,
        channelId: channel.id,
        body: message,
        createThread: true,
        metadata: { source: "pipeline", format: "markdown" },
      });
      const messageId = delivered.message?.id;
      if (!messageId) throw new Error("Tower accepted the direct message without returning a message id");
      return {
        delivered: true,
        fromNpub,
        toNpub,
        workspaceId: subscription.workspaceId!,
        channelId: channel.id,
        messageId,
        createdChannel,
      };
    });
  };
}

function selectSubscription(records: WorkspaceSubscriptionRecord[], fromNpub: string, toNpub: string): WorkspaceSubscriptionRecord {
  const candidates = records.filter((record) =>
    record.botNpub === fromNpub
    && record.workspaceId
    && (record.lifecycleStatus ?? "active") === "active"
  );
  const preferred = candidates.filter((record) => record.workspaceOwnerNpub === toNpub);
  const selected = preferred.length === 1 ? preferred[0] : candidates.length === 1 ? candidates[0] : null;
  if (!selected) {
    throw new Error(candidates.length === 0
      ? `No active workspace subscription exists for Autopilot agent ${fromNpub}`
      : `Autopilot agent ${fromNpub} has multiple workspace subscriptions and none resolves uniquely for ${toNpub}`);
  }
  return selected;
}

function isExactDirectMessage(channel: FlightDeckPgChannel, fromNpub: string, toNpub: string): boolean {
  const participants = [...new Set(channel.participant_npubs ?? [])].sort();
  return channel.kind === "dm"
    && participants.length === 2
    && participants[0] === [fromNpub, toNpub].sort()[0]
    && participants[1] === [fromNpub, toNpub].sort()[1];
}

function shortNpub(npub: string): string {
  return `${npub.slice(0, 12)}-${npub.slice(-8)}`;
}

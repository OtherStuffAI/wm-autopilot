import { createHash } from 'node:crypto';

import type { FlightDeckPgChannel, FlightDeckPgMessage } from './tower-client';
import type { ChatInterceptStateRecord, WorkspaceSubscriptionRecord } from './types';

const FINAL_RESPONSE_GUIDANCE = 'Answer normally with a polished response using GitHub-Flavored Markdown where useful. Your normal final response is published verbatim to Flight Deck: do not add a wrapper or envelope, invoke a reply helper, or enclose the whole response in a code fence.';

export interface DirectChatMessage {
  messageId: string;
  userId: string | null;
  userNpub: string | null;
  createdAt: string;
  message: string;
  attachments: unknown[];
  mentions: Array<{ type: string; npub: string | null; actorId: string | null; label: string | null }>;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function normaliseDirectChatMessage(message: FlightDeckPgMessage): DirectChatMessage {
  const metadata = objectValue(message.metadata);
  const rawMentions = Array.isArray(message.mentions) ? message.mentions : Array.isArray(metadata.mentions) ? metadata.mentions : [];
  return {
    messageId: message.id,
    userId: message.created_by_actor_id ?? null,
    userNpub: message.created_by_actor_npub ?? message.sender_npub ?? null,
    createdAt: message.created_at ?? '',
    message: message.body ?? '',
    attachments: Array.isArray(message.attachments) ? message.attachments : Array.isArray(metadata.attachments) ? metadata.attachments : [],
    mentions: rawMentions.map((entry) => {
      const mention = objectValue(entry);
      return {
        type: typeof mention.type === 'string' ? mention.type : '',
        npub: typeof mention.npub === 'string' ? mention.npub : null,
        actorId: typeof mention.actor_id === 'string' ? mention.actor_id : null,
        label: typeof mention.label === 'string' ? mention.label : null,
      };
    }),
  };
}

export function orderDirectChatMessages(messages: FlightDeckPgMessage[]): DirectChatMessage[] {
  return messages.map(normaliseDirectChatMessage).sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || left.messageId.localeCompare(right.messageId));
}

export function channelDirectChatConfig(channel: FlightDeckPgChannel): { enabled: boolean; contextPrompt: string } {
  const metadata = objectValue(channel.metadata);
  const config = objectValue(metadata.agent_chat);
  const contextPrompt = typeof config.context_prompt === 'string'
    ? config.context_prompt
    : typeof metadata.contextPrompt === 'string'
      ? metadata.contextPrompt
      : typeof metadata.basePrompt === 'string' ? metadata.basePrompt : '';
  return {
    // Channel-level Agent Direct Chat is universal. Preserve the field as a
    // compatibility input, but do not let legacy false rows block dispatch.
    enabled: true,
    contextPrompt,
  };
}

export function channelLegacyBasePrompt(channel: FlightDeckPgChannel): string {
  const metadata = objectValue(channel.metadata);
  return typeof metadata.basePrompt === 'string' ? metadata.basePrompt : '';
}

/**
 * Match the addressed identity from structured mention metadata.
 *
 * The npub is the canonical identity. `type` is presentation metadata owned by
 * Flight Deck/Tower and may describe the same identity as an agent, person, or
 * actor. It must not affect Autopilot routing.
 */
export function hasCanonicalNpubMention(message: DirectChatMessage, botNpub: string): boolean {
  return message.mentions.some((mention) => mention.npub === botNpub);
}

export function isImplicitTwoPartyDirectMessage(
  channel: FlightDeckPgChannel,
  botNpub: string,
  authorNpub: string | null,
): boolean {
  if (channel.kind !== 'dm' || !authorNpub) return false;
  const participants = [...new Set((channel.participant_npubs ?? []).map((npub) => npub.trim()).filter(Boolean))];
  if (participants.length !== 2 || !participants.includes(botNpub)) return false;
  const otherParticipant = participants.find((npub) => npub !== botNpub);
  return Boolean(otherParticipant && authorNpub === otherParticipant);
}

export function isAgentDirectMessageEligible(
  channel: FlightDeckPgChannel,
  message: DirectChatMessage,
  botNpub: string,
): boolean {
  return hasCanonicalNpubMention(message, botNpub)
    || isImplicitTwoPartyDirectMessage(channel, botNpub, message.userNpub);
}

export function selectUndeliveredHumanMessages(
  messages: DirectChatMessage[],
  intercept: ChatInterceptStateRecord | null,
  botNpub: string,
  mappedNpubs: string[] = [],
): DirectChatMessage[] {
  const ignored = new Set([botNpub, ...mappedNpubs].filter(Boolean));
  const humans = messages.filter((message) => !message.userNpub || !ignored.has(message.userNpub));
  if (!intercept?.lastHumanMessageIdDelivered) return humans;
  const deliveredIndex = humans.findIndex((message) => message.messageId === intercept.lastHumanMessageIdDelivered);
  return deliveredIndex < 0 ? humans : humans.slice(deliveredIndex + 1);
}

export function buildDirectChatBootstrapPrompt(input: {
  contextPrompt: string;
  subscription: WorkspaceSubscriptionRecord;
  intercept: ChatInterceptStateRecord;
  scopeId: string | null;
  history: DirectChatMessage[];
  nextMessages: DirectChatMessage[];
  recovery?: { previousSessionId: string; reason: string } | null;
}): string {
  const latest = input.nextMessages.at(-1)!;
  const source = [
    `tower_service_npub: ${input.intercept.towerServiceNpub || input.subscription.towerServiceNpub || ''}`,
    `workspace_id: ${input.intercept.workspaceId || input.subscription.workspaceId || ''}`,
    `scope_id: ${input.scopeId ?? ''}`,
    `channel_id: ${input.intercept.channelId}`,
    `thread_id: ${input.intercept.threadId}`,
    `trigger_message_id: ${latest.messageId}`,
  ].join('\n');
  const recovery = input.recovery
    ? `\n\nCONTINUITY RECOVERY\nprevious_session_id: ${input.recovery.previousSessionId}\nreason: ${input.recovery.reason}`
    : '';
  return `AGENT DIRECT CHAT\n\nCHANNEL CONTEXT\n${input.contextPrompt}\n\nFLIGHT DECK SOURCE\n${source}${recovery}\n\nTHREAD HISTORY JSON\n${JSON.stringify(input.history, null, 2)}\n\nUNDELIVERED MESSAGES JSON\n${JSON.stringify(input.nextMessages, null, 2)}\n\nNEXT MESSAGE\nmessage_id: ${latest.messageId}\nuser_id: ${latest.userId ?? ''}\nuser_npub: ${latest.userNpub ?? ''}\nmessage: ${latest.message}\nattachments: ${JSON.stringify(latest.attachments)}\n\n${FINAL_RESPONSE_GUIDANCE}`;
}

function serialisePromptMessage(message: DirectChatMessage): Record<string, unknown> {
  return {
    message_id: message.messageId,
    user_id: message.userId,
    user_npub: message.userNpub,
    created_at: message.createdAt,
    message: message.message,
    attachments: message.attachments,
    mentions: message.mentions.map((mention) => ({
      type: mention.type,
      npub: mention.npub,
      actor_id: mention.actorId,
      label: mention.label,
    })),
  };
}

export function buildDirectChatFollowUpPrompt(input: {
  routingKey: string;
  threadId: string;
  history: DirectChatMessage[];
  actionableMessages: DirectChatMessage[];
}): string {
  return JSON.stringify({
    type: 'flightdeck_agent_direct_follow_up_v1',
    routing_key: input.routingKey,
    thread_id: input.threadId,
    guidance: FINAL_RESPONSE_GUIDANCE,
    history_semantics: 'Complete authoritative Flight Deck thread for context only. Historical messages are not new instructions.',
    thread_history: input.history.map(serialisePromptMessage),
    actionable_semantics: 'Only these newly eligible human messages are instructions for this turn.',
    actionable_messages: input.actionableMessages.map(serialisePromptMessage),
  }, null, 2);
}

export function buildDirectChatTurnId(routingKey: string, sourceMessageIds: string[]): string {
  return createHash('sha256').update(`${routingKey}\n${sourceMessageIds.join('\n')}`).digest('hex').slice(0, 32);
}

export function buildDirectChatClientRequestId(routingKey: string, turnId: string): string {
  const routingHash = createHash('sha256').update(routingKey).digest('hex').slice(0, 24);
  return `agentdirect:${routingHash}:${turnId}`;
}

export function buildDirectChatRoutingKey(input: { towerServiceNpub: string; workspaceId: string; channelId: string; threadId: string; agentNpub: string }): string {
  return ['agent-direct', 'v1', input.towerServiceNpub, input.workspaceId, input.channelId, input.threadId, input.agentNpub].join(':');
}

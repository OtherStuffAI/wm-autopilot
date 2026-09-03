import { fetchFlightDeckPgChannel, fetchFlightDeckPgChannelMessages,
  type FlightDeckPgChannel, type FlightDeckPgEvent, type FlightDeckPgMessage } from './tower-client';
import type { RuntimeBotIdentity, WorkspaceSubscriptionRecord } from './types';

interface HydrationDependencies {
  fetchChannel: typeof fetchFlightDeckPgChannel;
  fetchMessages: typeof fetchFlightDeckPgChannelMessages;
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function eventThreadId(event: FlightDeckPgEvent): string | null {
  const payloadThreadId = optionalText(event.payload?.thread_id);
  if (payloadThreadId) return payloadThreadId;
  const directThreadId = optionalText(event.thread_id);
  if (directThreadId) return directThreadId;
  const route = optionalText(event.refetch?.route);
  if (!route) return event.entity_type === 'thread' ? optionalText(event.entity_id) : null;
  try {
    return optionalText(new URL(route, 'https://flightdeck.invalid').searchParams.get('thread_id'))
      ?? (event.entity_type === 'thread' ? optionalText(event.entity_id) : null);
  } catch {
    return event.entity_type === 'thread' ? optionalText(event.entity_id) : null;
  }
}

function threadTriggerMessageId(event: FlightDeckPgEvent): string | null {
  if (event.entity_type === 'message') return optionalText(event.entity_id);
  return optionalText(event.payload?.unarchived_by_message_id)
    ?? optionalText(event.payload?.message_id)
    ?? optionalText(event.payload?.source_message_id);
}

function compareMessages(left: FlightDeckPgMessage, right: FlightDeckPgMessage): number {
  const createdAt = String(left.created_at ?? '').localeCompare(String(right.created_at ?? ''));
  return createdAt || left.id.localeCompare(right.id);
}

async function fetchAllMessages(input: {
  subscription: WorkspaceSubscriptionRecord;
  botIdentity: RuntimeBotIdentity;
  channelId: string;
  threadId: string | null;
}, deps: HydrationDependencies): Promise<FlightDeckPgMessage[]> {
  if (!input.subscription.workspaceId) throw new Error('Agent Direct Chat requires a Flight Deck PG workspace id.');
  const messages: FlightDeckPgMessage[] = [];
  let cursor: string | null = null;
  do {
    const page = await deps.fetchMessages({
      backendBaseUrl: input.subscription.backendBaseUrl,
      workspaceId: input.subscription.workspaceId,
      channelId: input.channelId,
      appNpub: input.subscription.sourceAppNpub,
      botIdentity: input.botIdentity,
      threadId: input.threadId,
      effectiveTranscript: Boolean(input.threadId),
      cursor,
      limit: 200,
    });
    messages.push(...page.messages);
    cursor = page.next_cursor ?? null;
  } while (cursor);
  return messages.sort(compareMessages);
}

export async function hydrateDirectChatThread(input: {
  subscription: WorkspaceSubscriptionRecord;
  botIdentity: RuntimeBotIdentity;
  channelId: string;
  threadId: string;
}, deps: HydrationDependencies): Promise<{ channel: FlightDeckPgChannel; messages: FlightDeckPgMessage[] }> {
  if (!input.subscription.workspaceId) throw new Error('Agent Direct Chat requires a Flight Deck PG workspace id.');
  const common = { backendBaseUrl: input.subscription.backendBaseUrl, workspaceId: input.subscription.workspaceId,
    channelId: input.channelId, appNpub: input.subscription.sourceAppNpub, botIdentity: input.botIdentity };
  const messages = await fetchAllMessages({ ...input, threadId: input.threadId }, deps);
  let channel: FlightDeckPgChannel;
  try {
    channel = await deps.fetchChannel(common);
  } catch (error) {
    if (!error || typeof error !== 'object' || (error as { status?: unknown }).status !== 404) throw error;
    const firstMessage = messages[0];
    channel = {
      id: input.channelId,
      workspace_id: input.subscription.workspaceId,
      scope_id: firstMessage?.scope_id ?? null,
    };
  }
  return { channel, messages };
}

export async function hydrateFlightDeckPgChatEvent(input: {
  subscription: WorkspaceSubscriptionRecord;
  botIdentity: RuntimeBotIdentity;
  channelId: string;
  event: FlightDeckPgEvent;
  includeChannel: boolean;
}, deps: HydrationDependencies): Promise<{
  channel: FlightDeckPgChannel;
  messages: FlightDeckPgMessage[];
  message: FlightDeckPgMessage | null;
  threadId: string | null;
}> {
  const threadId = eventThreadId(input.event);
  const messages = await fetchAllMessages({ ...input, threadId }, deps);
  const triggerMessageId = threadTriggerMessageId(input.event);
  const message = triggerMessageId
    ? messages.find((candidate) => candidate.id === triggerMessageId) ?? null
    : null;
  let channel: FlightDeckPgChannel = {
    id: input.channelId,
    workspace_id: input.subscription.workspaceId!,
    scope_id: messages[0]?.scope_id ?? null,
  };
  if (!message || !input.includeChannel) return { channel, messages, message, threadId };
  try {
    channel = await deps.fetchChannel({
      backendBaseUrl: input.subscription.backendBaseUrl,
      workspaceId: input.subscription.workspaceId!,
      channelId: input.channelId,
      appNpub: input.subscription.sourceAppNpub,
      botIdentity: input.botIdentity,
    });
  } catch (error) {
    if (!error || typeof error !== 'object' || (error as { status?: unknown }).status !== 404) throw error;
    channel = { ...channel };
  }
  return { channel, messages, message, threadId };
}

import type { SessionSnapshot } from '../agents/process-manager';
import type { ChatInterceptStateRecord } from './types';
import type { FlightDeckTriggerResolver } from './flightdeck-session-turn-bridge';

interface FlightDeckInterceptReader {
  getByRoutingKey(routingKey: string): ChatInterceptStateRecord | null;
  listAll(): ChatInterceptStateRecord[];
}

function matchesSessionBinding(record: ChatInterceptStateRecord, session: SessionSnapshot): boolean {
  return record.workspaceId === session.metadata?.flightdeckWorkspaceId
    && record.channelId === session.metadata?.flightdeckChannelId
    && record.threadId === session.metadata?.flightdeckThreadId
    && record.botNpub === session.metadata?.flightdeckAgentNpub;
}

function selectTriggerMessageId(record: ChatInterceptStateRecord | null): string | null {
  return record?.lastAgentMessageIdPublished
    ?? record?.lastHumanMessageIdDelivered
    ?? record?.lastMessageIdSeen
    ?? null;
}

export function createFlightDeckTriggerResolver(store: FlightDeckInterceptReader): FlightDeckTriggerResolver {
  return (session) => {
    const routingKey = session.metadata?.flightdeckRoutingKey;
    const routed = routingKey ? store.getByRoutingKey(routingKey) : null;
    if (routed && matchesSessionBinding(routed, session)) return selectTriggerMessageId(routed);

    const compatible = store.listAll().find((record) => matchesSessionBinding(record, session)
      && (record.sessionId === session.id || record.previousSessionIds?.includes(session.id)));
    return selectTriggerMessageId(compatible ?? null);
  };
}

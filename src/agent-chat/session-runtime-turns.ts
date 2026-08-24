import type {
  AgentDefinitionRecord,
  ChatInterceptStateStatus,
  ChatInterceptStateRecord,
  RuntimeBotIdentity,
  WorkspaceSubscriptionRecord,
} from './types';
import type { QueuedChatTurn } from './session-runtime-prompts';

export const FORCE_INTERRUPT_FAILURE_ENV = 'AGENT_CHAT_FORCE_INTERRUPT_FAILURE';

type BlockedInterceptState = Extract<ChatInterceptStateStatus, 'blocked_auth' | 'blocked_decrypt'>;

export interface RoutingRuntimeState {
  processing: boolean;
  latestInput: {
    agent: AgentDefinitionRecord;
    subscription: WorkspaceSubscriptionRecord;
    intercept: ChatInterceptStateRecord;
    botIdentity: RuntimeBotIdentity;
    chatMessage: Record<string, unknown>;
    runtimeContext?: string | null;
  } | null;
  queuedTurns: QueuedChatTurn[];
  currentSessionId: string | null;
  interruptRequested: boolean;
  interruptAttemptInFlight: boolean;
  needsMergedFollowUp: boolean;
  blockedState: BlockedInterceptState | null;
}

function normaliseTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function getChatMessageId(chatMessage: Record<string, unknown>): string | null {
  const candidates = [chatMessage.record_id, chatMessage.message_id, chatMessage.id];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

function getMessageBody(chatMessage: Record<string, unknown>): string {
  return typeof chatMessage.body === 'string' ? chatMessage.body.trim() : '';
}

function getSenderNpub(chatMessage: Record<string, unknown>): string | null {
  const sender = typeof chatMessage.sender_npub === 'string' ? chatMessage.sender_npub.trim() : '';
  return sender || null;
}

export function toQueuedTurn(chatMessage: Record<string, unknown>): QueuedChatTurn {
  return {
    messageId: getChatMessageId(chatMessage),
    senderNpub: getSenderNpub(chatMessage),
    sentAt:
      normaliseTimestamp(chatMessage.sent_at)
      ?? normaliseTimestamp(chatMessage.created_at)
      ?? normaliseTimestamp(chatMessage.createdAt)
      ?? new Date().toISOString(),
    content: getMessageBody(chatMessage),
  };
}

export function isForcedInterruptFailure(): boolean {
  const value = process.env[FORCE_INTERRUPT_FAILURE_ENV];
  if (!value) {
    return false;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function isInterruptedTurnError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as { code?: unknown; message?: unknown; name?: unknown };
  if (candidate.code === 'agent_turn_interrupted' || candidate.name === 'AbortError') {
    return true;
  }
  return typeof candidate.message === 'string' && candidate.message.toLowerCase().includes('interrupted');
}

export function getRoutingState(
  routingStates: Map<string, RoutingRuntimeState>,
  routingKey: string,
): RoutingRuntimeState {
  let state = routingStates.get(routingKey);
  if (!state) {
    state = {
      processing: false,
      latestInput: null,
      queuedTurns: [],
      currentSessionId: null,
      interruptRequested: false,
      interruptAttemptInFlight: false,
      needsMergedFollowUp: false,
      blockedState: null,
    };
    routingStates.set(routingKey, state);
  }
  return state;
}

export function enqueueTurn(runtime: RoutingRuntimeState, chatMessage: Record<string, unknown>): void {
  const turn = toQueuedTurn(chatMessage);
  if (turn.messageId && runtime.queuedTurns.some((queuedTurn) => queuedTurn.messageId === turn.messageId)) {
    return;
  }
  runtime.queuedTurns.push(turn);
}

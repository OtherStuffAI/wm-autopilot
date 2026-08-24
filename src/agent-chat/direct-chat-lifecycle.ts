import type { ChatInterceptStateStore } from './chat-intercept-state-store';
import type { DirectChatTurnStore } from './direct-chat-turn-store';

export function isDirectChatSessionProtected(
  sessionId: string,
  interceptStore: Pick<ChatInterceptStateStore, 'listAll'>,
  turnStore: Pick<DirectChatTurnStore, 'getPending'>,
): boolean {
  return interceptStore.listAll().some((intercept) => {
    if (intercept.sessionId !== sessionId) return false;
    if (intercept.pendingMessageCount > 0) return true;
    if (intercept.state === 'pending' || intercept.state === 'active'
      || intercept.state === 'interrupting' || intercept.state === 'interrupt_failed') return true;
    const turn = turnStore.getPending(intercept.routingKey);
    return turn?.state === 'accepted' || turn?.state === 'reply_ready';
  });
}

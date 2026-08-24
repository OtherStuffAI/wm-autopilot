import { describe, expect, test } from 'bun:test';
import { isDirectChatSessionProtected } from '../agent-chat/direct-chat-lifecycle';
import { cleanupStopNextActionSessions } from './next-action-cleanup';

function session(id: string) {
  return {
    id,
    agent: 'codex',
    name: id,
    metadata: { AGENT: true, nextAction: 'stop' },
  } as any;
}

describe('next-action cleanup', () => {
  test('does not stop a Flight Deck session with active, pending, or accepted work', async () => {
    for (const state of ['active', 'pending', 'idle'] as const) {
      const stopped: string[] = [];
      const intercept = { routingKey: `route-${state}`, sessionId: `chat-${state}`, state,
        pendingMessageCount: state === 'pending' ? 2 : 0 } as any;
      const turn = state === 'idle' ? { state: 'accepted' } : null;
      const result = await cleanupStopNextActionSessions({ manager: { listSessions: () => [session(`chat-${state}`)],
        stopSession: async (id: string) => { stopped.push(id); } } as any, scheduleArchive: () => {},
        isSessionProtected: (id) => isDirectChatSessionProtected(id, { listAll: () => [intercept] } as any,
          { getPending: () => turn } as any) });
      expect(result.matched).toBe(0); expect(stopped).toEqual([]);
    }
  });

  test('still stops and archives a genuinely terminal eligible session', async () => {
    const stopped: string[] = []; const archived: string[] = [];
    const result = await cleanupStopNextActionSessions({ manager: { listSessions: () => [session('terminal-worker')],
      stopSession: async (id: string) => { stopped.push(id); } } as any, scheduleArchive: (id) => archived.push(id),
      isSessionProtected: () => false });
    expect(result.matched).toBe(1); expect(result.stopped).toBe(1);
    expect(stopped).toEqual(['terminal-worker']); expect(archived).toEqual(['terminal-worker']);
  });

  test('protects a production-shaped Example Operator-started session and its native resume', async () => {
    const exampleUserNpub = 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpz2c9sm';
    const directSession = {
      ...session('ccac87cc-e9be-4c4e-8381-e99c71e5a604'),
      metadata: {
        AGENT: false,
        nextAction: 'stop',
        ownerNpub: exampleUserNpub,
        createdByNpub: exampleUserNpub,
      },
    };
    const nativeResume = {
      ...session('bbedf2fa-03bd-4eee-aedb-d38bfaf8e4dd'),
      origin: { type: 'native-resume', id: directSession.id },
      metadata: {
        AGENT: false,
        nextAction: 'stop',
        ownerNpub: exampleUserNpub,
        createdByNpub: exampleUserNpub,
        resumedFromWingmanSessionId: directSession.id,
      },
    };
    const stopped: string[] = [];

    const result = await cleanupStopNextActionSessions({
      manager: {
        listSessions: () => [directSession, nativeResume],
        stopSession: async (id: string) => { stopped.push(id); },
      } as any,
      scheduleArchive: () => {},
    });

    expect(result.checked).toBe(2);
    expect(result.matched).toBe(0);
    expect(stopped).toEqual([]);
  });

  test('stops automatic worker and scheduler sessions', async () => {
    const worker = session('automatic-worker');
    const scheduler = {
      ...session('automatic-scheduler'),
      origin: { type: 'scheduler', id: 'close-out-sessions' },
      metadata: { AGENT: false, nextAction: 'stop' },
    };
    const stopped: string[] = [];
    const archived: string[] = [];

    const result = await cleanupStopNextActionSessions({
      manager: {
        listSessions: () => [worker, scheduler],
        stopSession: async (id: string) => { stopped.push(id); },
      } as any,
      scheduleArchive: (id) => archived.push(id),
    });

    expect(result.matched).toBe(2);
    expect(result.stopped).toBe(2);
    expect(stopped).toEqual(['automatic-worker', 'automatic-scheduler']);
    expect(archived).toEqual(stopped);
  });
});

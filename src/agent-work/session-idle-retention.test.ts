import { describe, expect, test } from 'bun:test';

import type { SessionSnapshot } from '../agents/process-manager';
import { AgentWorkSessionIdleRetention } from './session-idle-retention';

function makeSession(id: string, overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id,
    agent: 'codex',
    port: 3700,
    name: id,
    status: 'running',
    startedAt: new Date().toISOString(),
    command: ['codex'],
    workingDirectory: '/tmp/work',
    logs: [],
    metadata: {
      AGENT: true,
      role: 'agent-work',
      billingMode: 'subscription',
    },
    ...overrides,
  };
}

describe('AgentWorkSessionIdleRetention', () => {
  test('stops idle agent-work sessions after retention expires', async () => {
    const listeners: Array<(event: { type: string; session: SessionSnapshot }) => void> = [];
    const sessions = new Map<string, SessionSnapshot>([
      ['work-1', makeSession('work-1', { startedAt: new Date(Date.now() - 120_000).toISOString() })],
    ]);
    const stopped: string[] = [];
    const manager = {
      on(listener: (event: { type: string; session: SessionSnapshot }) => void) {
        listeners.push(listener);
        return () => undefined;
      },
      listSessions() {
        return [...sessions.values()];
      },
      getSession(id: string) {
        return sessions.get(id);
      },
      async stopSession(id: string) {
        const session = sessions.get(id);
        if (!session) {
          return undefined;
        }
        stopped.push(id);
        const next = { ...session, status: 'stopped' as const };
        sessions.set(id, next);
        for (const listener of listeners) {
          listener({ type: 'session-stopped', session: next });
        }
        return next;
      },
    };

    const retention = new AgentWorkSessionIdleRetention({
      processManager: manager as any,
      idleRetentionMinutes: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(stopped).toEqual(['work-1']);
    retention.dispose();
  });

  test('resets idle timer when an agent-work session updates', async () => {
    const listeners: Array<(event: { type: string; session: SessionSnapshot }) => void> = [];
    const sessions = new Map<string, SessionSnapshot>([
      ['work-2', makeSession('work-2')],
    ]);
    const stopped: string[] = [];
    const manager = {
      on(listener: (event: { type: string; session: SessionSnapshot }) => void) {
        listeners.push(listener);
        return () => undefined;
      },
      listSessions() {
        return [...sessions.values()];
      },
      getSession(id: string) {
        return sessions.get(id);
      },
      async stopSession(id: string) {
        stopped.push(id);
        const session = sessions.get(id);
        return session ? { ...session, status: 'stopped' as const } : undefined;
      },
    };

    const retention = new AgentWorkSessionIdleRetention({
      processManager: manager as any,
      idleRetentionMinutes: 1 / 60,
    });

    await new Promise((resolve) => setTimeout(resolve, 400));
    const updated = makeSession('work-2');
    sessions.set('work-2', updated);
    for (const listener of listeners) {
      listener({ type: 'session-updated', session: updated });
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(stopped).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(stopped).toEqual(['work-2']);
    retention.dispose();
  });

  test('ignores non agent-work sessions', async () => {
    const listeners: Array<(event: { type: string; session: SessionSnapshot }) => void> = [];
    const sessions = new Map<string, SessionSnapshot>([
      ['chat-1', makeSession('chat-1', { metadata: { AGENT: true, role: 'agent-chat', billingMode: 'subscription' } })],
    ]);
    const stopped: string[] = [];
    const manager = {
      on(listener: (event: { type: string; session: SessionSnapshot }) => void) {
        listeners.push(listener);
        return () => undefined;
      },
      listSessions() {
        return [...sessions.values()];
      },
      getSession(id: string) {
        return sessions.get(id);
      },
      async stopSession(id: string) {
        stopped.push(id);
        return sessions.get(id);
      },
    };

    const retention = new AgentWorkSessionIdleRetention({
      processManager: manager as any,
      idleRetentionMinutes: 1 / 60,
    });

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(stopped).toEqual([]);
    retention.dispose();
  });
});

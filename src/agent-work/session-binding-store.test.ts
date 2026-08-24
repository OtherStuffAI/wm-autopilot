import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test } from 'bun:test';

import { AgentWorkSessionBindingStore } from './session-binding-store';

function makeTempDb(): string {
  return join(tmpdir(), `agent-work-binding-store-${randomUUID()}.sqlite`);
}

describe('AgentWorkSessionBindingStore', () => {
  test('persists bindings and lists aliases by session', () => {
    const store = new AgentWorkSessionBindingStore(makeTempDb());
    const now = new Date().toISOString();

    store.save({
      subscriptionId: 'sub-1',
      agentId: 'agent-1',
      bindingType: 'flow_run',
      bindingId: 'flow-run-1',
      sessionId: 'session-1',
      lastRecordIdSeen: 'record-1',
      state: 'active',
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });
    store.save({
      subscriptionId: 'sub-1',
      agentId: 'agent-1',
      bindingType: 'task',
      bindingId: 'task-1',
      sessionId: 'session-1',
      lastRecordIdSeen: 'record-2',
      state: 'active',
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });

    expect(store.getByBinding('sub-1', 'agent-1', 'flow_run', 'flow-run-1')).toMatchObject({
      sessionId: 'session-1',
      lastRecordIdSeen: 'record-1',
    });
    expect(store.listBySession('sub-1', 'agent-1', 'session-1')).toHaveLength(2);
  });
});

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { AgentDefinitionStore } from './agent-definition-store';
import { AgentProfileMetadataCache } from './agent-profile-metadata-cache';
import type { AgentDefinitionRecord } from './types';

function makeStore() {
  return new AgentDefinitionStore(join(mkdtempSync(join(tmpdir(), 'agent-profile-cache-')), 'store.sqlite'));
}

function saveAgent(store: AgentDefinitionStore): AgentDefinitionRecord {
  return store.save({
    agentId: 'default-agent', label: 'Placeholder', botNpub: 'npub1default',
    workspaceOwnerNpub: 'npub1owner', groupNpubs: [], workingDirectory: '/work',
    harness: 'codex', model: 'model-1', publicProfile: {
      name: 'Placeholder', picture: null, about: null, nip05: null,
    },
    directChat: { enabled: true, sessionAgent: 'codex', directory: '/work', model: 'model-1', idleRetentionMinutes: 60 },
    capabilities: ['chat_intercept'], enabled: true, createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z', managedByNpub: 'npub1owner',
  });
}

describe('AgentProfileMetadataCache', () => {
  test('startup hydration changes only the public snapshot and provenance', async () => {
    const store = makeStore();
    const before = saveAgent(store);
    const cache = new AgentProfileMetadataCache({
      store, defaultAgentNpub: before.botNpub, relays: ['wss://relay.example'],
      fetchProfile: async () => ({
        eventId: 'event-2', createdAt: 200,
        profile: { name: 'Real Agent', picture: 'https://example.com/p.png', about: 'About', nip05: 'a@example.com' },
      }),
      setIntervalFn: (() => ({ unref() {} })) as unknown as typeof setInterval,
      clearIntervalFn: (() => undefined) as typeof clearInterval,
      now: () => new Date('2026-02-01T00:00:00.000Z'),
    });

    await cache.start();
    const after = store.getByAgentId(before.agentId)!;
    expect(after.publicProfile).toEqual({
      name: 'Real Agent', picture: 'https://example.com/p.png', about: 'About', nip05: 'a@example.com',
    });
    expect(after.publicProfileRefresh).toMatchObject({
      sourceEventId: 'event-2', sourceEventCreatedAt: 200, result: 'hydrated', error: null,
    });
    expect({ ...after, publicProfile: before.publicProfile, publicProfileRefresh: before.publicProfileRefresh })
      .toEqual(before);
  });

  test('failures and stale events preserve the last known good snapshot', async () => {
    const store = makeStore();
    const agent = saveAgent(store);
    store.updatePublicProfileSnapshot(agent.agentId,
      { name: 'Current', picture: 'current.png', about: 'Current about', nip05: 'current@example.com' },
      { lastAttemptAt: null, lastSuccessAt: '2026-01-01T00:00:00.000Z', sourceEventId: 'newer', sourceEventCreatedAt: 300, result: 'published', error: null });
    let fail = true;
    const cache = new AgentProfileMetadataCache({
      store, defaultAgentNpub: agent.botNpub, relays: ['wss://relay.example'],
      fetchProfile: async () => {
        if (fail) throw new Error('relay offline');
        return { eventId: 'older', createdAt: 200, profile: { name: 'Old', picture: null, about: null, nip05: null } };
      },
    });

    await cache.refresh();
    expect(store.getByAgentId(agent.agentId)?.publicProfile?.name).toBe('Current');
    fail = false;
    await cache.refresh();
    const after = store.getByAgentId(agent.agentId)!;
    expect(after.publicProfile?.name).toBe('Current');
    expect(after.publicProfileRefresh).toMatchObject({ sourceEventId: 'newer', sourceEventCreatedAt: 300, result: 'unchanged' });
  });

  test('one scheduler loop is reused and one interval tick performs one refresh', async () => {
    const store = makeStore();
    const agent = saveAgent(store);
    let scheduled: (() => void) | null = null;
    let intervalCount = 0;
    let fetchCount = 0;
    const cache = new AgentProfileMetadataCache({
      store, defaultAgentNpub: agent.botNpub, relays: ['wss://relay.example'], intervalMs: 24,
      setIntervalFn: ((callback: () => void) => {
        intervalCount += 1;
        scheduled = callback;
        return { unref() {} };
      }) as unknown as typeof setInterval,
      clearIntervalFn: (() => undefined) as typeof clearInterval,
      fetchProfile: async () => {
        fetchCount += 1;
        return { eventId: `event-${fetchCount}`, createdAt: fetchCount, profile: { name: 'Agent', picture: null, about: null, nip05: null } };
      },
    });

    await cache.start();
    await cache.start();
    expect(intervalCount).toBe(1);
    expect(fetchCount).toBe(1);
    scheduled!();
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchCount).toBe(2);
    cache.stop();
  });
});

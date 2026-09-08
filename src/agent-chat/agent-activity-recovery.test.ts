import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentActivityPublicationStore } from './agent-activity-publication-store';
import { AgentActivityRecovery } from './agent-activity-recovery';
import { AgentActivityPublisher, buildAgentActivityId } from './agent-activity-publisher';

const identity = { botNpub: 'agent', botPubkeyHex: 'public', botSecret: new Uint8Array([123, 42]) };
const context = { backendBaseUrl: 'https://tower.test', workspaceId: 'workspace', appNpub: 'app',
  botIdentity: identity, agentNpub: 'agent', channelId: 'channel', threadId: 'thread',
  triggerMessageId: 'trigger', sessionId: 'session', turnId: 'turn' };
const quiet = { error: () => {} };
const manager = { getSession: () => ({ agent: 'codex', metadata: { nativeAgentSession: {
  agent: 'codex', sessionId: 'native', workingDirectory: '/repo',
} } }) } as any;

describe('durable activity publication', () => {
  test('keeps a failed burst and terminal pending and replays them after restart without credentials on disk', async () => {
    const root = mkdtempSync(join(tmpdir(), 'activity-recovery-'));
    try {
      const path = join(root, 'isolated.sqlite');
      const store = new AgentActivityPublicationStore(path);
      const entries = [
        { content: 'One', createdAt: '2026-09-08T00:00:00Z', sourceId: '1' },
        { content: 'Two', createdAt: '2026-09-08T00:00:00Z', sourceId: '2' },
        { content: 'One', createdAt: '2026-09-08T00:00:00Z', sourceId: '3' },
      ];
      const publisher = new AgentActivityPublisher(context, async () => { throw new Error('offline'); },
        0, async () => entries, quiet, store);
      await publisher.publishLatestCommentary(manager);
      await publisher.publish('completed');
      expect(store.pending().map((row) => row.payload.body ?? row.payload.state)).toEqual(['One', 'Two', 'One', 'completed']);
      expect(JSON.stringify(store.pending())).not.toContain('botSecret');
      expect(JSON.stringify(store.pending())).not.toContain('botIdentity');
      const reloaded = new AgentActivityPublicationStore(path);
      const delivered: any[] = [];
      const recovery = new AgentActivityRecovery(() => identity, reloaded, async (request) => {
        delivered.push(request); return {};
      }, quiet);
      await recovery.recover();
      await recovery.recover();
      expect(delivered.map((row) => row.sequence)).toEqual([1, 2, 3, 4]);
      expect(reloaded.pending()).toEqual([]);
      const replay = new AgentActivityPublisher(context, async (request) => { delivered.push(request); return {}; },
        0, async () => entries, quiet, reloaded);
      await replay.publishLatestCommentary(manager);
      await replay.publish('completed');
      expect(delivered).toHaveLength(4);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('recovers an unclaimed transcript entry after terminal read failure and restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'activity-source-recovery-'));
    try {
      const source = { codexHome: root, sessionId: 'native-recovery', workingDirectory: '/repo' };
      const sessionDir = join(root, 'sessions', '2026', '09', '08');
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, 'rollout-2026-09-08T00-00-00-native-recovery.jsonl'), [
        { type: 'session_meta', timestamp: '2026-09-08T00:00:00Z', payload: { id: source.sessionId, cwd: '/repo' } },
        { type: 'event_msg', timestamp: '2026-09-08T00:00:01Z',
          payload: { type: 'agent_message', phase: 'commentary', message: 'Unclaimed final update' } },
      ].map((row) => JSON.stringify(row)).join('\n'));
      const path = join(root, 'isolated.sqlite');
      const store = new AgentActivityPublicationStore(path);
      const delivered: any[] = [];
      const deliver = async (request: any) => { delivered.push(request); return {}; };
      const publisher = new AgentActivityPublisher(context, deliver, 0,
        async () => { throw new Error('temporary transcript error'); }, quiet, store);
      await publisher.publish('working');
      await publisher.publishCommentaryFromSource(source);
      await publisher.publish('completed');
      expect(store.pendingCommentarySources()).toHaveLength(1);
      const reloaded = new AgentActivityPublicationStore(path);
      const recovery = new AgentActivityRecovery(() => identity, reloaded, deliver, quiet);
      await recovery.recover();
      await recovery.recover();
      expect(delivered.map((row) => row.body ?? row.state)).toEqual(['working', 'completed', 'Unclaimed final update']);
      expect(reloaded.pendingCommentarySources()).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('upgrades an accepted latest-only checkpoint without duplicating its history', async () => {
    const store = new AgentActivityPublicationStore(':memory:');
    const activity = { content: 'Already visible', createdAt: '2026-09-08T00:00:00Z', sourceId: '2' };
    const activityId = buildAgentActivityId(context);
    const legacyKey = `commentary:${activity.createdAt}:${createHash('sha256').update(activity.content).digest('hex').slice(0, 16)}`;
    store.claim(activityId, legacyKey, 0);
    store.markAccepted(activityId, legacyKey);
    const delivered: unknown[] = [];
    const publisher = new AgentActivityPublisher(context, async (request) => { delivered.push(request); return {}; },
      0, async () => [activity], quiet, store);
    await publisher.publishLatestCommentary(manager);
    await publisher.publishLatestCommentary(manager);
    expect(delivered).toEqual([]);
  });

  test('an older successful scan cannot clear a newer pending scan or regress accepted delivery', () => {
    const store = new AgentActivityPublicationStore(':memory:');
    const first = store.saveCommentarySource('activity', { source: 'first' });
    const second = store.saveCommentarySource('activity', { source: 'second' });
    store.finishCommentarySource('activity', first);
    expect(store.pendingCommentarySources()).toHaveLength(1);
    store.finishCommentarySource('activity', second);
    expect(store.pendingCommentarySources()).toEqual([]);
    store.claim('activity', 'entry', 0);
    store.markAccepted('activity', 'entry');
    store.markFailed('activity', 'entry', 'late timeout');
    expect(store.claim('activity', 'entry', 0).accepted).toBe(true);
  });

  test('retries an ambiguous emitted claim with the identical sequence after a crash', async () => {
    const store = new AgentActivityPublicationStore(':memory:');
    const { botIdentity: _identity, ...payload } = context;
    const claim = store.claim('activity', 'commentary:1', 0, undefined,
      { ...payload, activityId: 'activity', state: 'working', body: 'Public update' });
    const retried = store.claim('activity', 'commentary:1', 0);
    expect(retried).toMatchObject({ sequence: claim.sequence, duplicate: false, accepted: false });
    const acceptedSequences = new Set([claim.sequence]); // Tower accepted before the process crashed.
    const recovery = new AgentActivityRecovery(() => identity, store, async (request) => {
      acceptedSequences.add(request.sequence); return {};
    }, quiet);
    await recovery.recover();
    expect(acceptedSequences.size).toBe(1);
    expect(store.pending()).toEqual([]);
  });

  test('retries commentary on the next poll after failure without advancing its checkpoint', async () => {
    const store = new AgentActivityPublicationStore(':memory:');
    let online = false;
    const attempts: number[] = [];
    const publisher = new AgentActivityPublisher(context, async (request) => {
      attempts.push(request.sequence);
      if (!online) throw new Error('offline');
      return {};
    }, 0, async () => [{ content: 'Update', createdAt: '2026-09-08T00:00:00Z', sourceId: '1' }], quiet, store);
    await publisher.publishLatestCommentary(manager);
    online = true;
    await publisher.publishLatestCommentary(manager);
    await publisher.publishLatestCommentary(manager);
    expect(attempts).toEqual([1, 1, 1]);
    expect(store.pending()).toEqual([]);
  });

  test('isolates workspace and turn identities and prevents concurrent recovery polling', async () => {
    const store = new AgentActivityPublicationStore(':memory:');
    for (const extra of [{}, { workspaceId: 'other' }, { turnId: 'other' }]) {
      const publisher = new AgentActivityPublisher({ ...context, ...extra }, async () => { throw new Error('offline'); },
        0, undefined, quiet, store);
      await publisher.publish('accepted');
    }
    expect(new Set(store.pending().map((row) => row.activityId)).size).toBe(3);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delivered: any[] = [];
    const recovery = new AgentActivityRecovery((request) => request.workspaceId === 'workspace' ? identity : null,
      store, async (request) => { delivered.push(request); await gate; return {}; }, quiet);
    const first = recovery.recover();
    await recovery.recover();
    expect(delivered).toHaveLength(1);
    release();
    await first;
    expect(delivered).toHaveLength(2);
    expect(delivered.every((request) => request.workspaceId === 'workspace')).toBe(true);
  });
});

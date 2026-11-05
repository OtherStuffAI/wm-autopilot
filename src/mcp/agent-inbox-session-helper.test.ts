import { describe, expect, test } from 'bun:test';

describe('strict-inbox write provenance names only the session\'s own live origin', () => {
  const { currentInboxWriteOrigin, resolveInboxWriteOrigin } = require('./agent-inbox-session-helper');
  const { AgentInboxStore } = require('../agent-chat/agent-inbox-store');
  const { AgentInboxOriginStore, beginActiveInboxAttempt } = require('../agent-chat/agent-inbox-origins');
  const { mkdtempSync, rmSync } = require('node:fs');
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');

  const ids = (patch: Record<string, string | null>) => ({ channelId: null, threadId: null, taskId: null, documentId: null, ...patch });
  const envelope = (id: string, seq: number, source: Record<string, unknown>, occurredAt = '2026-11-03T01:00:00.000Z') => ({ id, seq, state: 'active', kind: 'chat_mention',
    occurred_at: occurredAt, source: { type: 'message', id: `src-${id}`, channel_id: 'channel-1', thread_id: null, task_id: null, doc_id: null, ...source } });
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'inbox-origins-'));
    const inbox = new AgentInboxStore(join(dir, 'db.sqlite'));
    const origins = new AgentInboxOriginStore(join(dir, 'db.sqlite'));
    inbox.setMode('sub-1', 'inbox_required', 'c');
    inbox.update('sub-1', { towerSubscriptionId: 'tower-sub', floorAt: '2026-11-02T00:00:00.000Z' });
    const handled = (id: string, seq: number, source: Record<string, unknown>, outcome = 'handled', occurredAt?: string) => {
      inbox.beginAttempt('sub-1', id, seq, envelope(id, seq, source, occurredAt));
      if (outcome !== 'started') inbox.markHandled('sub-1', id, seq, outcome, null);
    };
    return { dir, inbox, origins, handled, stores: { inbox, origins }, done: () => rmSync(dir, { recursive: true, force: true }) };
  }
  const owner = (patch: Record<string, unknown> = {}) => ({ sessionId: 'session-1', subscriptionId: 'sub-1', runId: null, ...patch });
  const code = async (result: unknown) => (result instanceof Response ? [(result as Response).status, (await (result as Response).json()).code] : 'ok');

  test('writes use only the current turn origin and its exact location', async () => {
    const f = fixture();
    try {
      f.handled('n-thread', 1, { thread_id: 'thread-1' });
      f.handled('n-task', 2, { type: 'task_comment', task_id: 'task-1' });
      f.handled('n-doc', 3, { type: 'doc_comment', doc_id: 'doc-1' });
      f.origins.recordTurn('session-1', { subscriptionId: 'sub-1', notificationId: 'n-thread' });
      expect(await code(resolveInboxWriteOrigin(owner(), 'chat_reply', ids({ channelId: 'channel-1', threadId: 'thread-1' }), f.stores))).toBe('ok');
      expect(await code(resolveInboxWriteOrigin(owner(), 'doc_create', ids({ channelId: 'channel-1' }), f.stores))).toBe('ok');
      expect(await code(resolveInboxWriteOrigin(owner(), 'file_upload', ids({ channelId: 'channel-1' }), f.stores))).toBe('ok');
      expect(await code(resolveInboxWriteOrigin(owner(), 'task_create', ids({ channelId: 'channel-1' }), f.stores))).toBe('ok');
      // Other locations are refused even though other handled notifications bind them (no cross-notification fallback).
      for (const [action, where] of [
        ['task_comment', ids({ taskId: 'task-1' })], ['doc_reply', ids({ documentId: 'doc-1' })],
        ['chat_reply', ids({ channelId: 'channel-1', threadId: 'thread-other' })], ['doc_create', ids({ channelId: 'channel-other' })], ['file_upload', ids({})],
        ['task_create', ids({ channelId: 'channel-other' })], ['task_create', ids({})],
      ] as const) {
        expect([action, await code(resolveInboxWriteOrigin(owner(), action, where, f.stores))]).toEqual([action, [403, 'agent_inbox_write_unbound']]);
      }
      // A new turn switches the session's origin atomically: the old thread is no longer writable from this session.
      f.origins.recordTurn('session-1', { subscriptionId: 'sub-1', notificationId: 'n-task' });
      expect(await code(resolveInboxWriteOrigin(owner(), 'task_comment', ids({ taskId: 'task-1' }), f.stores))).toBe('ok');
      expect(await code(resolveInboxWriteOrigin(owner(), 'chat_reply', ids({ channelId: 'channel-1', threadId: 'thread-1' }), f.stores)))
        .toEqual([403, 'agent_inbox_write_unbound']);
      // Another session never borrows these origins; a session without any origin acts for nothing.
      expect(await code(resolveInboxWriteOrigin(owner({ sessionId: 'session-2' }), 'task_comment', ids({ taskId: 'task-1' }), f.stores)))
        .toEqual([403, 'agent_inbox_no_origin']);
      // Another subscription's origin rows are ignored.
      expect(await code(resolveInboxWriteOrigin(owner({ subscriptionId: 'sub-2' }), 'task_comment', ids({ taskId: 'task-1' }), f.stores)))
        .toEqual([403, 'agent_inbox_no_origin']);
    } finally { f.done(); }
  });

  test('only the actively processed attempt or a handled, unrevoked, post-floor notification is live', async () => {
    const f = fixture();
    try {
      const write = () => resolveInboxWriteOrigin(owner(), 'chat_reply', ids({ channelId: 'channel-1', threadId: 'thread-1' }), f.stores);
      f.handled('n-1', 1, { thread_id: 'thread-1' }, 'started');
      f.origins.recordTurn('session-1', { subscriptionId: 'sub-1', notificationId: 'n-1' });
      expect(await code(write())).toEqual([403, 'agent_inbox_origin_expired']);
      const end = beginActiveInboxAttempt('sub-1', 'n-1');
      expect(await code(write())).toBe('ok'); // the current dispatch may write inline before its outcome is recorded
      end();
      expect(await code(write())).toEqual([403, 'agent_inbox_origin_expired']);
      for (const outcome of ['failed_permanent', 'suppressed', 'source_gone']) {
        f.inbox.markHandled('sub-1', 'n-1', 1, outcome, null);
        expect([outcome, await code(write())]).toEqual([outcome, [403, 'agent_inbox_origin_expired']]);
        // Even an active-looking registry entry never revives a recorded failure.
        const stale = beginActiveInboxAttempt('sub-1', 'n-1');
        expect([outcome, await code(write())]).toEqual([outcome, [403, 'agent_inbox_origin_expired']]);
        stale();
      }
      f.inbox.markHandled('sub-1', 'n-1', 1, 'handled', null);
      expect(await code(write())).toBe('ok');
      // Pre-floor notification (e.g. after re-anchoring with a new floor) is not live; no silent renewal.
      f.inbox.update('sub-1', { floorAt: '2026-11-03T02:00:00.000Z' });
      expect(await code(write())).toEqual([403, 'agent_inbox_origin_expired']);
      f.inbox.update('sub-1', { towerSubscriptionId: 'tower-sub', floorAt: '2026-11-02T00:00:00.000Z' });
      // A revoked envelope is never live.
      f.handled('n-rev', 2, { thread_id: 'thread-1' });
      f.inbox.beginAttempt('sub-1', 'n-rev', 2, { ...envelope('n-rev', 2, { thread_id: 'thread-1' }), state: 'revoked' });
      f.origins.recordTurn('session-1', { subscriptionId: 'sub-1', notificationId: 'n-rev' });
      expect(await code(write())).toEqual([403, 'agent_inbox_origin_expired']);
    } finally { f.done(); }
  });

  test('an ordinary authorized write outside the origin location carries no origin and is not refused', async () => {
    const f = fixture();
    try {
      f.handled('n-1', 1, { thread_id: 'thread-1' });
      f.origins.recordTurn('session-1', { subscriptionId: 'sub-1', notificationId: 'n-1' });
      expect(currentInboxWriteOrigin(owner(), 'chat_reply', ids({ channelId: 'channel-1', threadId: 'thread-1' }), f.stores)?.envelope.id).toBe('n-1');
      expect(currentInboxWriteOrigin(owner(), 'doc_create', ids({ channelId: 'channel-1' }), f.stores)?.envelope.id).toBe('n-1');
      // Elsewhere, or without any origin, the write is a plain bot write (Tower ACL decides): no origin, no refusal.
      expect(currentInboxWriteOrigin(owner(), 'chat_reply', ids({ channelId: 'channel-2', threadId: 'thread-9' }), f.stores)).toBeUndefined();
      expect(currentInboxWriteOrigin(owner(), 'doc_create', ids({ channelId: 'channel-2' }), f.stores)).toBeUndefined();
      expect(currentInboxWriteOrigin(owner({ sessionId: 'other' }), 'chat_reply', ids({ channelId: 'channel-1', threadId: 'thread-1' }), f.stores)).toBeUndefined();
      // Reads and non-provenance writes never resolve an origin.
      for (const action of ['thread_read', 'doc_get', 'task_comment', 'doc_update', 'transport_request']) {
        expect([action, currentInboxWriteOrigin(owner(), action, ids({ channelId: 'channel-1', threadId: 'thread-1' }), f.stores)]).toEqual([action, undefined]);
      }
    } finally { f.done(); }
  });

  test('a worker snapshot or run origin is immutable and replaces session turns', async () => {
    const f = fixture();
    try {
      f.handled('n-1', 1, { thread_id: 'thread-1' });
      f.handled('n-2', 2, { thread_id: 'thread-2' });
      f.origins.recordTurn('session-1', { subscriptionId: 'sub-1', notificationId: 'n-2' });
      f.origins.recordTurn('worker-1', { subscriptionId: 'sub-1', notificationId: 'n-2' }); // a turn never overrides the snapshot
      f.origins.recordWorker('worker-1', { subscriptionId: 'sub-1', notificationId: 'n-1' });
      f.origins.recordWorker('worker-1', { subscriptionId: 'sub-1', notificationId: 'n-2' }); // ignored: fixed at dispatch
      const worker = owner({ sessionId: 'worker-1' });
      expect(await code(resolveInboxWriteOrigin(worker, 'chat_reply', ids({ channelId: 'channel-1', threadId: 'thread-1' }), f.stores))).toBe('ok');
      expect(await code(resolveInboxWriteOrigin(worker, 'chat_reply', ids({ channelId: 'channel-1', threadId: 'thread-2' }), f.stores)))
        .toEqual([403, 'agent_inbox_write_unbound']);
      f.origins.recordRun('run-1', { subscriptionId: 'sub-1', notificationId: 'n-1' });
      f.origins.recordRun('run-1', { subscriptionId: 'sub-1', notificationId: 'n-2' }); // ignored: fixed at creation
      const run = owner({ sessionId: 'pipeline-session', runId: 'run-1' });
      expect(await code(resolveInboxWriteOrigin(run, 'chat_reply', ids({ channelId: 'channel-1', threadId: 'thread-1' }), f.stores))).toBe('ok');
      expect(await code(resolveInboxWriteOrigin(run, 'chat_reply', ids({ channelId: 'channel-1', threadId: 'thread-2' }), f.stores)))
        .toEqual([403, 'agent_inbox_write_unbound']);
    } finally { f.done(); }
  });
});

describe('strict-inbox deliberate self-address', () => {
  const { inboxSelfAddress } = require('./agent-inbox-session-helper');
  const origin = { ok: true, origin: { subscriptionId: 'sub-1', notificationId: 'n-self' }, envelope: { id: 'n-self' }, towerOriginId: 'n-human' } as any;

  test('names the live non-self origin only for a structured agent mention of the bot itself', () => {
    const self = [{ type: 'agent', npub: 'npub1bot', label: 'Me' }, { type: 'agent', npub: 'npub1other' }];
    expect(inboxSelfAddress(origin, self, 'npub1bot')).toEqual({ originNotificationId: 'n-human', mentions: self });
    expect(inboxSelfAddress(origin, [{ type: 'agent', npub: 'npub1other' }], 'npub1bot')).toBeNull();
    expect(inboxSelfAddress(origin, undefined, 'npub1bot')).toBeNull();
    // Legacy sessions (no origin) send ordinary messages, unchanged.
    expect(inboxSelfAddress(undefined, self, 'npub1bot')).toBeNull();
  });
});

describe('strict-inbox work receipts are Tower-minted only', () => {
  const { workReceiptOf } = require('./agent-inbox-session-helper');
  test('surfaces a receipt object from the Tower response unchanged; nothing otherwise', () => {
    const receipt = { entity_type: 'task', entity_id: 'task-1', receipt_row_version: 1, origin_notification_id: 'n-1', body_sha256_hex: null };
    expect(workReceiptOf({ task: { id: 'task-1' }, work_receipt: receipt })).toEqual({ work_receipt: receipt });
    for (const value of [{ task: {} }, { work_receipt: 'x' }, { work_receipt: [receipt] }, null, undefined]) expect(workReceiptOf(value)).toEqual({});
  });
});

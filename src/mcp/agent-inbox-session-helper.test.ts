import { describe, expect, test } from 'bun:test';
import { answerInboxRead, inboxLocation } from './agent-inbox-session-helper';

const scope = (trigger: any, window: any = {}) => ({ notification: { id: 'n-1', seq: 1, state: 'active' } as any, profileNpub: 'npub1bot', context: { trigger, window, channel: { id: 'c-1' } } as any });

describe('strict-inbox MCP session reads', () => {
  test('thread_read returns only the bounded transcript and trigger, flagged as bounded', async () => {
    const response = answerInboxRead('thread_read', scope({ type: 'message', message: { id: 'm-2', channel_id: 'c-1', thread_id: 't-1', body: 'now' } }, { messages: [{ id: 'm-1', body: 'before' }], truncated: true }));
    const body = await response.json();
    expect(body.messages.map((m: any) => m.id)).toEqual(['m-1', 'm-2']);
    expect([body.bounded, body.complete, body.notification_id]).toEqual([true, false, 'n-1']);
  });

  test('doc_get decodes the bound document body and exposes the captured base for safe updates', async () => {
    const content = JSON.stringify({ format: 'document_content_v1', markdown: '# Hi' });
    const response = answerInboxRead('doc_get', scope({ type: 'doc', document: { id: 'doc-1', row_version: 3, channel_id: 'c-1', body: { encoding: 'base64', base64_data: Buffer.from(content).toString('base64'), sha256_hex: 'a'.repeat(64) },
      canonical_version: { version_id: 'v-3', row_version: 3, body_sha256_hex: 'a'.repeat(64) } } }));
    const body = await response.json();
    expect(body.doc.id).toBe('doc-1');
    expect(body.captured_base).toMatchObject({ row_version: 3, base_version_id: 'v-3' });
  });

  test('reads that do not match the bound notification are refused, never served from a raw read', async () => {
    const chatOnly = scope({ type: 'message', message: { id: 'm-1', channel_id: 'c-1', thread_id: null, body: 'x' } });
    for (const action of ['doc_get', 'doc_comments', 'task_comments', 'task_get']) {
      const response = answerInboxRead(action, chatOnly);
      expect([action, response.status, (await response.json()).code]).toEqual([action, 403, 'agent_inbox_context_unbound']);
    }
    expect(inboxLocation('task_comments', { channelId: 'c', threadId: 't', taskId: 'task-1', documentId: null })).toEqual({ taskId: 'task-1' });
    expect(inboxLocation('thread_read', { channelId: 'c', threadId: 't', taskId: null, documentId: null })).toEqual({ channelId: 'c', threadId: 't' });
  });
});

describe('strict-inbox attachment download (download-only, bound)', () => {
  const { answerInboxAttachment } = require('./agent-inbox-session-helper');
  const secret = new Uint8Array(32).fill(7);
  const { getPublicKey, nip19 } = require('nostr-tools');
  const target = (fetchImpl: any) => ({ subscriptionId: 's', backendConnectionId: null, backendBaseUrl: 'https://tower.example', workspaceId: 'ws', appNpub: 'app',
    botIdentity: { botNpub: nip19.npubEncode(getPublicKey(secret)), botPubkeyHex: getPublicKey(secret), botSecret: secret }, fetchImpl });
  const withAttachment = scope({ type: 'message', message: { id: 'm-1', channel_id: 'c-1', thread_id: 't-1', body: 'x', attachments: [{ storage_object_id: 'obj-1', file_name: 'a.txt' }] } });

  test('only attachments of the bound context are fetched, through the notification route', async () => {
    const urls: string[] = [];
    const fetchImpl = async (url: string) => { urls.push(url); return new Response('hello', { headers: { 'content-type': 'text/plain' } }); };
    const refused = await answerInboxAttachment(target(fetchImpl), withAttachment, 'obj-other');
    expect([refused.status, (await refused.json()).code]).toEqual([403, 'agent_inbox_context_unbound']);
    expect(urls).toEqual([]);
    const ok = await (await answerInboxAttachment(target(fetchImpl), withAttachment, 'obj-1')).json();
    expect(Buffer.from(ok.base64_data, 'base64').toString()).toBe('hello');
    expect(urls).toEqual(['https://tower.example/api/v4/flightdeck-pg/workspaces/ws/agent-notifications/n-1/attachments/obj-1']);
  });
});

describe('strict-inbox session calls act only for their own origin notification', () => {
  const { resolveInboxReadOrigin, resolveInboxWriteOrigin } = require('./agent-inbox-session-helper');
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

  test('reads use the current origin or an earlier turn of the same session, never a newer or foreign notification', async () => {
    const f = fixture();
    try {
      f.handled('n-1', 1, { thread_id: 'thread-1' });
      f.handled('n-2', 2, { type: 'task_comment', task_id: 'task-1' });
      f.handled('n-3', 3, { thread_id: 'thread-1' }); // a later notification for the same thread, delivered elsewhere
      f.origins.recordTurn('session-1', { subscriptionId: 'sub-1', notificationId: 'n-1' });
      f.origins.recordTurn('session-1', { subscriptionId: 'sub-1', notificationId: 'n-2' });
      const thread = resolveInboxReadOrigin(owner(), { channelId: 'channel-1', threadId: 'thread-1' }, f.stores);
      expect(thread.ok && thread.envelope.id).toBe('n-1');
      const task = resolveInboxReadOrigin(owner(), { taskId: 'task-1' }, f.stores);
      expect(task.ok && task.envelope.id).toBe('n-2');
      expect(await code(resolveInboxReadOrigin(owner(), { docId: 'doc-1' }, f.stores))).toEqual([403, 'agent_inbox_no_bound_notification']);
      expect(await code(resolveInboxReadOrigin(owner({ sessionId: 'other' }), { channelId: 'channel-1', threadId: 'thread-1' }, f.stores)))
        .toEqual([403, 'agent_inbox_no_origin']);
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

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

describe('strict-inbox session writes are notification-bound', () => {
  const { requireInboxWriteBinding } = require('./agent-inbox-session-helper');
  const { AgentInboxStore } = require('../agent-chat/agent-inbox-store');
  const { mkdtempSync, rmSync } = require('node:fs');
  const { join } = require('node:path');
  const { tmpdir } = require('node:os');

  test('replies, task comments, doc replies and created docs need a handled notification for that location', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inbox-writes-'));
    try {
      const store = new AgentInboxStore(join(dir, 'db.sqlite'));
      store.setMode('sub-1', 'inbox_required', 'c');
      const envelope = (id: string, source: Record<string, unknown>) => ({ id, seq: 1, state: 'active', kind: 'chat_mention',
        source: { type: 'message', id: `src-${id}`, channel_id: 'channel-1', thread_id: null, task_id: null, doc_id: null, ...source } });
      store.beginAttempt('sub-1', 'n-thread', 1, envelope('n-thread', { thread_id: 'thread-1' }));
      store.beginAttempt('sub-1', 'n-task', 2, envelope('n-task', { type: 'task_comment', task_id: 'task-1' }));
      store.beginAttempt('sub-1', 'n-doc', 3, envelope('n-doc', { type: 'doc_comment', doc_id: 'doc-1' }));
      const ids = (patch: Record<string, string | null>) => ({ channelId: null, threadId: null, taskId: null, documentId: null, ...patch });
      const allowed = [
        ['chat_reply', ids({ channelId: 'channel-1', threadId: 'thread-1' })],
        ['task_comment', ids({ taskId: 'task-1' })],
        ['doc_reply', ids({ documentId: 'doc-1' })],
        ['doc_create', ids({ channelId: 'channel-1' })],
      ] as const;
      for (const [action, where] of allowed) expect([action, requireInboxWriteBinding('sub-1', action, where, store)]).toEqual([action, null]);
      const refused = [
        ['chat_reply', ids({ channelId: 'channel-1', threadId: 'thread-other' })],
        ['chat_reply', ids({ channelId: 'channel-1' })],
        ['task_comment', ids({ taskId: 'task-other' })],
        ['doc_reply', ids({ documentId: 'doc-other' })],
        ['doc_create', ids({ channelId: 'channel-other' })],
      ] as const;
      for (const [action, where] of refused) {
        const response = requireInboxWriteBinding('sub-1', action, where, store);
        expect([action, response?.status, (await response?.json())?.code]).toEqual([action, 403, 'agent_inbox_write_unbound']);
      }
      // Another subscription's ledger never authorizes this one.
      expect(requireInboxWriteBinding('sub-2', 'chat_reply', ids({ threadId: 'thread-1' }), store)?.status).toBe(403);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

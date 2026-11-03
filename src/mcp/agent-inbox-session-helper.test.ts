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

import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateSecretKey, getPublicKey, nip19, verifyEvent } from 'nostr-tools';

import {
  AgentInboxError, classifyAgentInboxError, listAgentInbox, signStrictNip98,
  type AgentInboxEnvelope, type AgentInboxRequestContext,
} from './agent-inbox-client';
import { AgentInboxProcessor } from './agent-inbox-runtime';
import { AgentInboxUnboundReadError, agentInboxScope, inboxAwareFetchers, synthesizeInboxEvents, type AgentInboxContext } from './agent-inbox-scope';
import { AgentInboxStore } from './agent-inbox-store';
import { normaliseDocumentDirectTrigger, isDocumentDirectEvent } from './document-direct-contract';
import { normaliseTaskDirectTrigger, isTaskDirectEvent } from './task-direct-contract';
import type { WorkspaceSubscriptionRecord } from './types';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const secret = generateSecretKey();
const profileNpub = nip19.npubEncode(getPublicKey(secret));
const otherNpub = nip19.npubEncode(getPublicKey(generateSecretKey()));
const identity = () => ({ botNpub: profileNpub, botPubkeyHex: getPublicKey(secret), botSecret: new Uint8Array(secret) });
const request = (fetchImpl?: AgentInboxRequestContext['fetchImpl']): AgentInboxRequestContext => ({
  backendBaseUrl: 'https://tower.example', workspaceId: 'ws-1', appNpub: 'npub1app', botIdentity: identity(), fetchImpl,
});
const record = { subscriptionId: 'sub-1', botNpub: profileNpub } as WorkspaceSubscriptionRecord;

function decodeAuth(header: string) {
  return JSON.parse(Buffer.from(header.replace(/^Nostr /, ''), 'base64').toString('utf8'));
}

describe('strict agent inbox client', () => {
  test('signs a fresh exact-request NIP-98 event with u (incl. query), method, payload and a unique nonce', async () => {
    const url = 'https://tower.example/api/v4/flightdeck-pg/workspaces/ws-1/agent-notifications?cursor=a~b&limit=50';
    const first = decodeAuth(await signStrictNip98(request(), url, 'GET', ''));
    const second = decodeAuth(await signStrictNip98(request(), url, 'GET', ''));
    expect(verifyEvent(first)).toBe(true);
    const tag = (event: any, name: string) => event.tags.find((t: string[]) => t[0] === name)?.[1];
    expect(tag(first, 'u')).toBe(url);
    expect(tag(first, 'method')).toBe('GET');
    expect(tag(first, 'payload')).toBe(createHash('sha256').update('').digest('hex'));
    expect(tag(first, 'nonce')).toHaveLength(32);
    expect(tag(first, 'nonce')).not.toBe(tag(second, 'nonce'));
    expect(first.id).not.toBe(second.id);
    const posted = decodeAuth(await signStrictNip98(request(), url, 'POST', '{"a":1}'));
    expect(tag(posted, 'payload')).toBe(createHash('sha256').update('{"a":1}').digest('hex'));
  });

  test('never sends an audience parameter and classifies failures without skipping authorization', async () => {
    let seen = '';
    await listAgentInbox(request(async (url) => { seen = url; return Response.json({ subscription_id: 's', notifications: [], next_cursor: 'c', has_more: false }); }), 'cur', 10);
    expect(seen).not.toContain('audience');
    expect(classifyAgentInboxError(401, 'nip98_replayed')).toBe('auth');
    expect(classifyAgentInboxError(403, 'workspace_membership_required')).toBe('auth');
    expect(classifyAgentInboxError(403, 'agent_notification_upgrade_required')).toBe('auth');
    expect(classifyAgentInboxError(403, 'relationship_removed')).toBe('relationship');
    expect(classifyAgentInboxError(403, 'access_revoked')).toBe('relationship');
    expect(classifyAgentInboxError(410, 'source_gone')).toBe('source_gone');
    expect(classifyAgentInboxError(404, 'notification_not_found')).toBe('not_found');
    expect(classifyAgentInboxError(404, 'not_found')).toBe('unsupported');
    expect(classifyAgentInboxError(409, 'cursor_gap')).toBe('gap');
    expect(classifyAgentInboxError(400, 'invalid_cursor')).toBe('cursor');
    expect(classifyAgentInboxError(503, 'x')).toBe('transient');
  });
});

const envelope = (over: Partial<AgentInboxEnvelope> = {}): AgentInboxEnvelope => ({
  id: 'n-1', seq: 1, state: 'active', kind: 'chat_mention', reason: 'canonical_mention', author_npub: otherNpub, occurred_at: '2026-11-03T00:00:00Z',
  source: { type: 'message', id: 'm-1', version: 1, channel_id: 'c-1', thread_id: 't-1', task_id: null, doc_id: null }, ...over,
});
const chatContext: AgentInboxContext = {
  channel: { id: 'c-1', workspace_id: 'ws-1', scope_id: 's-1', name: 'General', kind: 'channel', metadata: { agent_chat: { enabled: true } } },
  thread: { id: 't-1' },
  trigger: { type: 'message', message: { id: 'm-1', channel_id: 'c-1', thread_id: 't-1', body: 'hi', mentions: [{ type: 'agent', npub: profileNpub }] } },
  window: { messages: [{ id: 'm-0', channel_id: 'c-1', thread_id: 't-1', body: 'root', inherited: false }], truncated: false },
};

describe('event synthesis maps each strict notification onto the existing handler contracts for THIS profile only', () => {
  test('chat notifications become message events evidenced for the profile only', () => {
    const [event] = synthesizeInboxEvents(envelope(), chatContext, profileNpub);
    expect(event).toMatchObject({ entity_type: 'message', entity_id: 'm-1', channel_id: 'c-1', thread_id: 't-1', visible_to_audience_npubs: [profileNpub] });
    expect(JSON.stringify(event)).not.toContain(otherNpub);
  });

  test('task assignment, task mention and task comment mention satisfy the task-direct trigger contract', () => {
    const task = { task_id: 'task-1', thread_id: null, doc_id: null, channel_id: 'c-1' };
    for (const [kind, reason, sourceId] of [['task_assigned', 'agent_assigned', 'task-1'], ['task_mention', 'description_mention_added', 'task-1'], ['task_comment_mention', 'comment_mention_added', 'cm-1']] as const) {
      const [event] = synthesizeInboxEvents(envelope({ kind, source: { type: kind === 'task_comment_mention' ? 'task_comment' : 'task', id: sourceId, version: 2, ...task } }), chatContext, profileNpub);
      expect(isTaskDirectEvent(event!)).toBe(true);
      const trigger = normaliseTaskDirectTrigger(event!);
      expect(trigger?.taskId).toBe('task-1');
      expect([...trigger!.reasonsByAgentNpub.entries()]).toEqual([[profileNpub, [reason]]]);
    }
  });

  test('document mentions, comment mentions and full reviews satisfy the document-direct contract', () => {
    const doc = { task_id: null, thread_id: null, doc_id: 'doc-1', channel_id: 'c-1' };
    const [mention] = synthesizeInboxEvents(envelope({ kind: 'document_mention', source: { type: 'doc', id: 'doc-1', version: 3, ...doc } }), chatContext, profileNpub);
    expect(normaliseDocumentDirectTrigger(mention!)).toMatchObject({ documentId: 'doc-1', reason: 'document_mention_added', targetAgentNpubs: [profileNpub] });
    const [comment] = synthesizeInboxEvents(envelope({ kind: 'document_comment_mention', source: { type: 'doc_comment', id: 'dc-1', version: 1, ...doc } }), chatContext, profileNpub);
    expect(normaliseDocumentDirectTrigger(comment!)).toMatchObject({ documentId: 'doc-1', reason: 'document_comment_mention_added', sourceCommentId: 'dc-1' });
    const review = synthesizeInboxEvents(envelope({ kind: 'document_review', source: { type: 'invocation', id: 'inv-1', version: 1, ...doc } }),
      { ...chatContext, trigger: { type: 'invocation', invocation: { id: 'inv-1', prompt: 'p', targets: [{ type: 'document', id: 'doc-1' }] } } }, profileNpub);
    expect(review.map((e) => e.entity_type)).toEqual(['invocation', 'doc']);
    expect(isDocumentDirectEvent(review[1]!)).toBe(true);
    expect(normaliseDocumentDirectTrigger(review[1]!)).toMatchObject({ reason: 'full_document_review_requested', targetAgentNpubs: [profileNpub] });
    expect((review[0]!.payload as any).recipients).toEqual([{ type: 'agent', npub: profileNpub }]);
  });
});

describe('inbox-aware fetchers', () => {
  const calls: string[] = [];
  const real = {
    fetchChannel: async (p: any) => { calls.push(`channel:${p.channelId}`); return { id: p.channelId, name: 'RAW' }; },
    fetchMessages: async (p: any) => { calls.push(`messages:${p.threadId}`); return { messages: [{ id: 'RAW' }], next_cursor: null }; },
    fetchTask: async (p: any) => { calls.push(`task:${p.taskId}`); return { task: { id: p.taskId } }; },
  };
  const wrapped = inboxAwareFetchers(real);

  test('outside a scope they delegate unchanged', async () => {
    calls.length = 0;
    expect(await wrapped.fetchChannel({ channelId: 'x' })).toEqual({ id: 'x', name: 'RAW' });
    expect(calls).toEqual(['channel:x']);
  });

  test('inside a scope no raw read is made: bound thread from context, other threads empty, unbound primary entities refused', async () => {
    calls.length = 0;
    await agentInboxScope.run({ notification: envelope(), context: chatContext, profileNpub }, async () => {
      const bound = await wrapped.fetchMessages({ channelId: 'c-1', threadId: 't-1', effectiveTranscript: true });
      expect(bound.messages.map((m: any) => m.id)).toEqual(['m-0', 'm-1']);
      expect((await wrapped.fetchMessages({ channelId: 'c-1', threadId: 'sibling' })).messages).toEqual([]);
      expect(await wrapped.fetchChannel({ channelId: 'c-1' })).toMatchObject({ id: 'c-1', name: 'General' });
      expect(await wrapped.fetchChannel({ channelId: 'c-2', workspaceId: 'ws-1' })).toEqual({ id: 'c-2', workspace_id: 'ws-1', scope_id: null });
      await expect(wrapped.fetchTask({ taskId: 'task-9' })).rejects.toBeInstanceOf(AgentInboxUnboundReadError);
    });
    expect(calls).toEqual([]);
  });
});

describe('AgentInboxProcessor', () => {
  function harness(opts: { notifications?: AgentInboxEnvelope[]; contextError?: (id: string) => AgentInboxError | null; ackFail?: (id: string, n: number) => AgentInboxError | null; listError?: AgentInboxError | null; dispatchError?: Error | null } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'agent-inbox-'));
    dirs.push(dir);
    const store = new AgentInboxStore(join(dir, 'db.sqlite'));
    store.setMode('sub-1', 'inbox_required', 'consumer-1');
    const dispatched: string[] = [];
    const acks: Array<[string, string, string | null]> = [];
    const ackAttempts = new Map<string, number>();
    const recorded: string[] = [];
    let listCalls = 0;
    const processor = new AgentInboxProcessor({
      store,
      dispatch: async (_record, event) => {
        if (opts.dispatchError) throw opts.dispatchError;
        dispatched.push(String(event.entity_id));
      },
      record: (_r, entry) => { recorded.push(`${entry.notification.id}:${entry.outcome}:${entry.code ?? ''}`); },
      maxAttempts: 2,
      client: {
        createSubscription: async () => ({ recipient_npub: profileNpub, created: true, subscription: { id: 'tower-sub', consumer_id: 'consumer-1', floor_at: '2026-11-02T00:00:00Z', policy_version: 1, acked_through_seq: 0 }, cursor: 'tower-sub~c0' }),
        list: async () => {
          listCalls += 1;
          if (opts.listError) throw opts.listError;
          return { subscription_id: 'tower-sub', notifications: opts.notifications ?? [], next_cursor: 'tower-sub~c1', has_more: false };
        },
        context: async (_ctx, id) => {
          const error = opts.contextError?.(id);
          if (error) throw error;
          return chatContext as any;
        },
        ack: async (_ctx, id, input) => {
          const n = (ackAttempts.get(id) ?? 0) + 1;
          ackAttempts.set(id, n);
          const error = opts.ackFail?.(id, n);
          if (error) throw error;
          acks.push([id, input.outcome, input.code ?? null]);
          return { outcome: input.outcome, replayed: false, acked_through_seq: 1 };
        },
      },
    });
    return { store, processor, dispatched, acks, recorded, listCalls: () => listCalls };
  }

  test('handles in order, acks outcomes, advances the cursor only after the page is done', async () => {
    const h = harness({
      notifications: [envelope({ id: 'a', seq: 1 }), { id: 'b', seq: 2, state: 'revoked' }, envelope({ id: 'c', seq: 3 })],
      contextError: (id) => (id === 'c' ? new AgentInboxError(410, 'source_gone', 'source_gone', 'gone') : null),
    });
    expect(await h.processor.pollOnce(record, request())).toEqual({ status: 'idle' });
    expect(h.dispatched).toEqual(['m-1']);
    expect(h.acks).toEqual([['a', 'handled', null], ['b', 'suppressed', 'revoked'], ['c', 'source_gone', 'source_gone']]);
    expect(h.store.get('sub-1')?.cursor).toBe('tower-sub~c1');
  });

  test('authorization failures halt without advancing; nothing is skipped or acked', async () => {
    const h = harness({ notifications: [envelope({ id: 'a' })], contextError: () => new AgentInboxError(403, 'workspace_membership_required', 'auth', 'no') });
    const result = await h.processor.pollOnce(record, request());
    expect(result).toMatchObject({ status: 'halt', code: 'workspace_membership_required' });
    expect(h.acks).toEqual([]);
    expect(h.dispatched).toEqual([]);
    expect(h.store.get('sub-1')?.cursor).toBe('tower-sub~c0');
  });

  test('a crash between handling and ack never re-executes the work', async () => {
    const h = harness({ notifications: [envelope({ id: 'a' })], ackFail: (_id, n) => (n === 1 ? new AgentInboxError(503, 'unavailable', 'transient', 'down') : null) });
    expect((await h.processor.pollOnce(record, request())).status).toBe('backoff');
    expect(h.dispatched).toEqual(['m-1']);
    expect(h.store.get('sub-1')?.cursor).toBe('tower-sub~c0');
    expect((await h.processor.pollOnce(record, request())).status).toBe('idle');
    expect(h.dispatched).toEqual(['m-1']); // not dispatched twice
    expect(h.acks).toEqual([['a', 'handled', null]]);
  });

  test('poison notifications are bounded: transient failures retry, then dead-letter as failed_permanent', async () => {
    const h = harness({ notifications: [envelope({ id: 'p' })], contextError: () => new AgentInboxError(503, 'unavailable', 'transient', 'down') });
    expect((await h.processor.pollOnce(record, request())).status).toBe('backoff');
    expect((await h.processor.pollOnce(record, request())).status).toBe('backoff');
    expect((await h.processor.pollOnce(record, request())).status).toBe('idle');
    expect(h.acks).toEqual([['p', 'failed_permanent', 'max_attempts']]);
    expect(h.recorded.at(-1)).toBe('p:failed_permanent:max_attempts');
  });

  test('relationship removal and access loss are acknowledged as suppressed', async () => {
    const h = harness({ notifications: [envelope({ id: 'r' })], contextError: () => new AgentInboxError(403, 'relationship_removed', 'relationship', 'gone') });
    await h.processor.pollOnce(record, request());
    expect(h.acks).toEqual([['r', 'suppressed', 'relationship_removed']]);
  });

  test('Tower without the inbox fails closed (no fallback); retention gaps recover through the explicit recovery cursor', async () => {
    const unsupported = harness({ listError: new AgentInboxError(404, 'not_found', 'unsupported', 'missing') });
    expect((await unsupported.processor.pollOnce(record, request())).status).toBe('unsupported');
    const gap = harness({ listError: new AgentInboxError(409, 'cursor_gap', 'gap', 'gap', { recovery_cursor: 'tower-sub~c9', from_seq: 1, through_seq: 9 }) });
    expect((await gap.processor.pollOnce(record, request())).status).toBe('more');
    expect(gap.store.get('sub-1')?.cursor).toBe('tower-sub~c9');
    expect(JSON.parse(gap.store.get('sub-1')!.lastGap!)).toMatchObject({ from_seq: 1, through_seq: 9 });
  });

  test('a refused reply (403 from Tower) is terminal for that notification, not a retry storm', async () => {
    const h = harness({ notifications: [envelope({ id: 'w' })], dispatchError: Object.assign(new Error('refused'), { status: 403, detailCode: 'agent_notification_upgrade_required' }) });
    await h.processor.pollOnce(record, request());
    expect(h.acks).toEqual([['w', 'failed_permanent', 'agent_notification_upgrade_required']]);
  });
});

describe('AgentInboxStore never writes on the read path', () => {
  test('legacy runtimes and tests that only read do not create inbox tables in the shared database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-inbox-ro-'));
    dirs.push(dir);
    const file = join(dir, 'db.sqlite');
    const store = new AgentInboxStore(file);
    expect(store.isInboxRequired('sub-x')).toBe(false);
    expect(store.ledger('sub-x', 'n')).toBeNull();
    expect(store.bindingRecord('sub-x', 'n')).toBeNull();
    const { Database } = require('bun:sqlite');
    const db = new Database(file, { readonly: true });
    expect(db.query("SELECT name FROM sqlite_master WHERE name LIKE 'agent_inbox%'").all()).toEqual([]);
    store.setMode('sub-x', 'inbox_required', 'c');
    expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'agent_inbox%' ORDER BY name").all().map((r: any) => r.name)).toEqual(['agent_inbox_ledger', 'agent_inbox_state']);
  });

  test('bindingRecord returns one exact notification of one subscription, never a location lookup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-inbox-bound-'));
    dirs.push(dir);
    const store = new AgentInboxStore(join(dir, 'db.sqlite'));
    store.setMode('sub-1', 'inbox_required', 'c');
    store.beginAttempt('sub-1', 'n-1', 1, envelope({ id: 'n-1', seq: 1 }));
    expect(store.bindingRecord('sub-1', 'n-1')).toMatchObject({ envelope: { id: 'n-1' }, outcome: null, handledAt: null });
    store.markHandled('sub-1', 'n-1', 1, 'handled', null);
    expect(store.bindingRecord('sub-1', 'n-1')).toMatchObject({ outcome: 'handled' });
    expect(store.bindingRecord('sub-2', 'n-1')).toBeNull();
    expect(store.bindingRecord('sub-1', 'n-2')).toBeNull();
  });
});

describe('crash safety around handler acceptance (fresh processor = process restart)', () => {
  function world() {
    const dir = mkdtempSync(join(tmpdir(), 'agent-inbox-crash-'));
    dirs.push(dir);
    const store = new AgentInboxStore(join(dir, 'db.sqlite'));
    store.setMode('sub-1', 'inbox_required', 'consumer-1');
    const sideEffects: string[] = []; // handler-durable evidence (e.g. dispatch history / accepted turn)
    const acks: Array<[string, string, string | null]> = [];
    const client = {
      createSubscription: async () => ({ recipient_npub: profileNpub, created: true, subscription: { id: 'tower-sub', consumer_id: 'consumer-1', floor_at: 'x', policy_version: 1, acked_through_seq: 0 }, cursor: 'tower-sub~c0' }),
      list: async () => ({ subscription_id: 'tower-sub', notifications: [envelope({ id: 'k', seq: 1 })], next_cursor: 'tower-sub~c1', has_more: false }),
      context: async () => chatContext as any,
      ack: async (_c: any, id: string, input: any) => { acks.push([id, input.outcome, input.code ?? null]); return { outcome: input.outcome, replayed: false, acked_through_seq: 1 }; },
    };
    const processor = (dispatch: () => Promise<void>) => new AgentInboxProcessor({
      store, client, dispatch: async () => dispatch(), record: () => {},
      reconcile: (_r, n) => sideEffects.includes(n.id),
    });
    return { store, sideEffects, acks, processor };
  }

  test('crash AFTER the handler accepted (side effect durable) but before the handled record: no replay on restart', async () => {
    const w = world();
    const first = w.processor(async () => { w.sideEffects.push('k'); throw new Error('process crashed after acceptance'); });
    expect((await first.pollOnce(record, request())).status).toBe('backoff');
    expect(w.store.ledger('sub-1', 'k')).toMatchObject({ handledAt: null });
    let dispatchedAgain = 0;
    const restarted = w.processor(async () => { dispatchedAgain += 1; w.sideEffects.push('k'); });
    expect((await restarted.pollOnce(record, request())).status).toBe('idle');
    expect(dispatchedAgain).toBe(0);
    expect(w.sideEffects).toEqual(['k']);
    expect(w.acks).toEqual([['k', 'handled', 'reconciled_in_flight']]);
  });

  test('crash BEFORE the handler accepted: restart dispatches exactly once', async () => {
    const w = world();
    const first = w.processor(async () => { throw new Error('process crashed before acceptance'); });
    expect((await first.pollOnce(record, request())).status).toBe('backoff');
    const restarted = w.processor(async () => { w.sideEffects.push('k'); });
    expect((await restarted.pollOnce(record, request())).status).toBe('idle');
    expect(w.sideEffects).toEqual(['k']);
    expect(w.acks).toEqual([['k', 'handled', null]]);
  });

  test('crash after the handled record but before the ack: restart acks only', async () => {
    const w = world();
    let dispatches = 0;
    const store = w.store;
    const first = w.processor(async () => { dispatches += 1; w.sideEffects.push('k'); });
    const originalAck = (first as any).deps.client.ack;
    (first as any).deps.client.ack = async () => { throw new AgentInboxError(0, 'network_error', 'transient', 'crash before ack'); };
    expect((await first.pollOnce(record, request())).status).toBe('backoff');
    expect(store.ledger('sub-1', 'k')).toMatchObject({ outcome: 'handled', ackedAt: null });
    (first as any).deps.client.ack = originalAck;
    const restarted = w.processor(async () => { dispatches += 1; });
    expect((await restarted.pollOnce(record, request())).status).toBe('idle');
    expect(dispatches).toBe(1);
    expect(w.acks).toEqual([['k', 'handled', null]]);
  });
});

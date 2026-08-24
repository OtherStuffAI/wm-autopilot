import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { DocumentDirectRuntime, DocumentDirectStore, compactDocumentDiff } from './document-direct-runtime';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'document-direct-'));
  dirs.push(dir);
  const store = new DocumentDirectStore(join(dir, 'state.sqlite'));
  const sessions = new Map<string, any>();
  const prompts: string[] = [];
  let creates = 0;
  let body = 'version one';
  const processManager = {
    getSession: (id: string) => sessions.get(id) ?? null,
    createSession: async (...args: any[]) => {
      creates += 1;
      const session = { id: `session-${creates}`, status: 'running', metadata: args[6] };
      sessions.set(session.id, session);
      return session;
    },
  };
  const runtime = new DocumentDirectRuntime({
    defaultAgent: 'codex', processManager: processManager as any, store,
    agentStore: { listByWorkspaceAndBot: () => [{ agentId: 'exampleAgent', label: 'Example Agent', botNpub: 'npub-exampleAgent',
      workspaceOwnerNpub: 'npub-workspace', managedByNpub: 'npub-human', workingDirectory: '/repo', enabled: true,
      capabilities: [], groupNpubs: [], createdAt: '', updatedAt: '' }] } as any,
    fetchDocument: async () => ({ doc: { id: 'doc-1', channel_id: 'channel-1', row_version: prompts.length + 1 },
      body: { encoding: 'base64', base64_data: Buffer.from(JSON.stringify({ content_model: { content: body } })).toString('base64'), sha256_hex: `hash-${prompts.length + 1}` } }) as any,
    fetchComments: async () => ({ comments: [{ id: 'comment-1', parent_comment_id: null }], next_cursor: null }) as any,
    fetchChannel: async () => ({ id: 'channel-1', metadata: { linked_task_id: 'task-1' } }) as any,
    sendFinalResponse: async (_manager, sessionId, prompt) => {
      prompts.push(prompt);
      const commentId = prompt.includes('document_comment_reply:comment-1') ? 'comment-1' : null;
      store.recordCallback({ sessionId, kind: commentId ? 'document_comment_reply' : 'document_update', documentId: 'doc-1', commentId, state: 'succeeded' });
      return { content: 'captured but not published', createdAt: new Date().toISOString() };
    },
  });
  const subscription = { subscriptionId: 'sub-1', workspaceServiceNpub: 'npub-workspace', workspaceOwnerNpub: 'npub-human',
    backendBaseUrl: 'http://tower', towerServiceNpub: 'npub-tower', workspaceId: 'workspace-1', sourceAppNpub: 'npub-app',
    botNpub: 'npub-exampleAgent', wsKeyNpub: 'npub-workspace-key', managedByNpub: 'npub-human' } as any;
  const botIdentity = { botNpub: 'npub-exampleAgent', botPubkeyHex: '00', botSecret: new Uint8Array() };
  const event = (id: string, eventType = 'document_mention_added') => ({ event_id: id, event_type: eventType,
    entity_type: eventType.includes('comment') ? 'document_comment' : 'document', entity_id: 'doc-1', operation: 'updated',
    actor_npub: 'npub-human', payload: { document_id: 'doc-1', comment_id: eventType.includes('comment') ? 'comment-1' : undefined,
      added_mentions: [{ type: 'agent', npub: 'npub-exampleAgent' }] } });
  return { runtime, store, sessions, prompts, subscription, botIdentity, event, setBody: (value: string) => { body = value; }, get creates() { return creates; } };
}

describe('DocumentDirectRuntime', () => {
  test('reuses a live session, creates generations, suppresses replay/self, and never publishes final turns', async () => {
    const f = fixture();
    const first = f.event('event-1');
    await f.runtime.handle({ subscription: f.subscription, botIdentity: f.botIdentity, event: first });
    await f.runtime.waitForIdle();
    await f.runtime.handle({ subscription: f.subscription, botIdentity: f.botIdentity, event: first });
    await f.runtime.handle({ subscription: f.subscription, botIdentity: f.botIdentity, event: { ...f.event('self'), actor_npub: 'npub-exampleAgent' } });
    await f.runtime.waitForIdle();
    expect(f.creates).toBe(1);
    expect(f.prompts).toHaveLength(1);
    expect(f.store.listBindings({ workspaceId: 'workspace-1', documentId: 'doc-1' })[0]?.callbackOutcome).toBe('complete');
    f.sessions.get('session-1').status = 'failed';
    f.setBody('version two');
    await f.runtime.handle({ subscription: f.subscription, botIdentity: f.botIdentity, event: f.event('event-2') });
    await f.runtime.waitForIdle();
    expect(f.creates).toBe(2);
    expect(f.prompts[1]).toContain('version one');
    expect(f.store.listBindings({ workspaceId: 'workspace-1', documentId: 'doc-1' })
      .map((binding) => ({ sessionId: binding.sessionId, generation: binding.generation })))
      .toEqual([{ sessionId: 'session-2', generation: 2 }, { sessionId: 'session-1', generation: 1 }]);
  });

  test('requires an inline reply callback for comment mentions', async () => {
    const f = fixture();
    await f.runtime.handle({ subscription: f.subscription, botIdentity: f.botIdentity, event: f.event('comment-event', 'document_comment_mention_added') });
    await f.runtime.waitForIdle();
    expect(f.prompts[0]).toContain('document_comment_reply:comment-1');
    expect(f.store.listBindings({ workspaceId: 'workspace-1', documentId: 'doc-1' })[0]?.callbackOutcome).toBe('complete');
  });

  test('marks a captured final turn incomplete when the required callback was not made', async () => {
    const f = fixture();
    (f.runtime as any).deps.sendFinalResponse = async () => ({ content: 'no callback', createdAt: new Date().toISOString() });
    await f.runtime.handle({ subscription: f.subscription, botIdentity: f.botIdentity, event: f.event('event-no-callback') });
    await f.runtime.waitForIdle();
    expect(f.store.listBindings({ workspaceId: 'workspace-1', documentId: 'doc-1' })[0]?.callbackOutcome).toBe('incomplete');
  });

  test('produces compact diffs while full bodies remain available', () => {
    expect(compactDocumentDiff('one\ntwo\nthree', 'one\nchanged\nthree')).toContain('-two\n+changed');
  });
});

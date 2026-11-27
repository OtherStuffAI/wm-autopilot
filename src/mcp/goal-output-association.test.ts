import { expect, test } from 'bun:test';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { createWingmanMcpApiHandler, type WingmanMcpApiDependencies } from './wingman-api';
import { inheritWorkerContext } from '../session-dispatch/worker-context';
import type { SessionSnapshot } from '../agents/process-manager';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const channelId = '22222222-2222-4222-8222-222222222222';
const threadId = '33333333-3333-4333-8333-333333333333';
const goalId = '44444444-4444-4444-8444-444444444444';
const reference = { version: 1, goal_file_id: goalId };

test('inherited worker context exposes primary and automatically associates Doc/File outputs without accessing private goal content', async () => {
  const sourceReference = { ...reference, future: { retained_on_thread: true }, access_snapshot: 'not authority' };
  const originalReference = structuredClone(sourceReference);
  const botSecret = generateSecretKey(); const botPubkeyHex = getPublicKey(botSecret); const botNpub = nip19.npubEncode(botPubkeyHex);
  const parent = { id: 'parent', npub: 'owner', metadata: { AGENT: true, billingMode: 'subscription',
    flightdeckTowerServiceNpub: 'tower', flightdeckWorkspaceId: workspaceId, flightdeckChannelId: channelId,
    flightdeckThreadId: threadId, agentChatBotNpub: botNpub } } as unknown as SessionSnapshot;
  const worker = { id: 'worker', npub: 'owner', metadata: { ...inheritWorkerContext(parent, {}, () => true), AGENT: false, billingMode: 'subscription' } } as unknown as SessionSnapshot;
  const handler = createWingmanMcpApiHandler({ getSession: () => worker,
    resolveFlightDeckDirectContext: () => ({ subscriptionId: 'sub', backendBaseUrl: 'http://tower.test', appNpub: 'app', botIdentity: { botSecret, botNpub, botPubkeyHex, towerTransport: { prepare: async (url: string) => url, fetch: (url: string, init: RequestInit) => globalThis.fetch(url, init) } } }),
  } as unknown as WingmanMcpApiDependencies);
  const originalFetch = globalThis.fetch; const writes: Array<Record<string, unknown>> = []; const paths: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init); const path = new URL(request.url).pathname; paths.push(path);
    if (path.endsWith(`/threads/${threadId}`)) return Response.json({ thread: { id: threadId, workspace_id: workspaceId, channel_id: channelId, metadata: { ambulando_goal: sourceReference } } });
    if (path.endsWith(`/files/${goalId}`)) return Response.json({ error: 'denied' }, { status: 403 });
    if (path.endsWith('/storage/prepare')) return Response.json({ object_id: 'object' });
    if (request.method === 'PUT') return Response.json({ ok: true });
    if (path.endsWith('/complete')) return Response.json({ object_id: 'object' });
    if (path.endsWith('/docs') || path.endsWith('/files')) {
      const body = await request.json() as Record<string, unknown>; writes.push(body);
      return Response.json(path.endsWith('/docs') ? { doc: { id: 'doc', metadata: body.metadata } } : { file: { id: 'file', metadata: body.metadata } }, { status: 201 });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  }) as typeof fetch;
  const call = async (action: string, extra = {}) => {
    const request = new Request('http://localhost/api/mcp/wingman/flightdeck', { method: 'POST', body: JSON.stringify({ sessionId: 'worker', action, ...extra }) });
    return handler(request, new URL(request.url), 'POST');
  };
  try {
    const context = await call('context');
    expect(await context!.json()).toMatchObject({ goal_context: { primary: reference, workspace_id: workspaceId, thread_id: threadId, goals: [{ status: 'acl_unavailable' }] } });
    const doc = await call('doc_create', { title: 'Vision', body: 'Text', metadata: { custom: 'retained', ambulando_goal: { version: 1, goal_file_id: channelId } } });
    expect(doc?.status).toBe(200);
    const file = await call('file_upload', { fileName: 'whiteboard.json', contentType: 'application/json', base64_data: Buffer.from('{}').toString('base64'), metadata: { artefact: { version: 1 } } });
    expect(file?.status).toBe(200);
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ metadata: { custom: 'retained', ambulando_goal: reference } });
    expect(writes[1]).toMatchObject({ metadata: { artefact: { version: 1 }, ambulando_goal: reference } });
    expect(writes.map(body => body.metadata.ambulando_goal)).toEqual([reference, reference]);
    expect(sourceReference).toEqual(originalReference);
    expect(paths.filter(p => p.endsWith(`/threads/${threadId}`))).toHaveLength(3);
    expect(paths.some(p => p.includes(`/files/${goalId}/versions`))).toBe(false);
  } finally { globalThis.fetch = originalFetch; }
});

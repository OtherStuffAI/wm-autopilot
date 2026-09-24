import { describe, expect, test } from 'bun:test';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { LiveThreadActivityHub } from '../agent-chat/live-thread-activity';
import { DelegationScopes } from '../auth/delegation-access';
import type { RequestAuthContext } from '../auth/request-context';
import { handleLiveThreadActivityApi, type LiveThreadActivityRoutesContext } from './live-thread-activity-routes';

const npub = () => nip19.npubEncode(getPublicKey(generateSecretKey()));
const owner = npub(); const agent = npub(); const tower = npub(); const app = npub();
const routingKey = 'route-authoritative';

function auth(subject = owner): RequestAuthContext {
  return { npub: subject, actorNpub: subject, signerNpub: subject, subjectNpub: subject,
    session: null, authMethod: 'nip98' };
}

function fixture() {
  const hub = new LiveThreadActivityHub();
  const intercept = { routingKey, subscriptionId: 'subscription-1', agentId: 'agent-1', sessionId: 'session-1',
    sessionGeneration: 2, previousSessionIds: [], sessionClass: 'chat', workspaceOwnerNpub: owner,
    sourceAppNpub: app, towerServiceNpub: tower, workspaceId: 'workspace-1', channelId: 'channel-1',
    threadId: 'thread-1', botNpub: agent, pendingMessageCount: 0, state: 'active', lastDecision: 'respond',
    lastActivityAt: '', createdAt: '', updatedAt: '' } as never;
  const turn = { turnId: 'turn-1', routingKey } as never;
  const context: LiveThreadActivityRoutesContext = {
    workspaceDelegationStore: { findActiveDelegation: () => null } as never,
    interceptStore: { listAll: () => [intercept] }, turnStore: { getPending: () => turn }, hub, keepaliveMs: 60_000,
  };
  const query = new URLSearchParams({ workspace_id: 'workspace-1', tower_service_npub: tower, app_npub: app,
    channel_id: 'channel-1', agent_npub: agent });
  const url = (resource = 'snapshot', mutate = '') => new URL(`https://autopilot.test/api/owners/${owner}/control-plane/v1/live-threads/thread-1/${resource}?${query}${mutate}`);
  return { hub, context, url };
}

describe('live thread activity routes', () => {
  test('projects only public activity for the authoritative route', async () => {
    const f = fixture();
    f.hub.publish({ workspaceId: 'workspace-1', channelId: 'channel-1', threadId: 'thread-1', agentNpub: agent,
      sessionId: 'session-1', turnId: 'turn-1', sequence: 9, lifecycle: 'working', commentary: 'Checking tests.',
      activityStatus: 'Working', timestamp: '2026-09-24T00:00:00Z' });
    const response = await handleLiveThreadActivityApi(new Request(f.url()), f.url(), 'GET', auth(), f.context);
    expect(response?.status).toBe(200);
    const body = await response!.json();
    expect(body.activity).toEqual(expect.objectContaining({ routing_key: routingKey, session_generation: 2,
      turn_id: 'turn-1', sequence: 9, commentary: 'Checking tests.', activity_status: 'Working' }));
    expect(JSON.stringify(body)).not.toMatch(/session-1|reasoning|raw|secret|tool_input|provider/);
  });

  test('rejects wrong route context, signer, and stale session data', async () => {
    const f = fixture();
    f.hub.publish({ workspaceId: 'workspace-1', channelId: 'channel-1', threadId: 'thread-1', agentNpub: agent,
      sessionId: 'old-session', turnId: 'turn-1', sequence: 1, lifecycle: 'working', timestamp: new Date().toISOString() });
    const stale = await handleLiveThreadActivityApi(new Request(f.url()), f.url(), 'GET', auth(), f.context);
    expect((await stale!.json()).activity).toBeNull();
    const wrongWorkspace = f.url(); wrongWorkspace.searchParams.set('workspace_id', 'wrong');
    expect((await handleLiveThreadActivityApi(new Request(wrongWorkspace), wrongWorkspace, 'GET', auth(), f.context))?.status).toBe(404);
    expect((await handleLiveThreadActivityApi(new Request(f.url()), f.url(), 'GET', auth(npub()), f.context))?.status).toBe(403);
  });

  test('allows an exact delegated request and rejects missing scope', async () => {
    const f = fixture(); const delegate = npub();
    f.context.workspaceDelegationStore = { findActiveDelegation: (_owner, subject, scope) => subject === delegate && scope === DelegationScopes.ControlPlaneRead
      ? { ownerNpub: owner, delegateNpub: delegate, scopes: [DelegationScopes.ControlPlaneRead] } as never : null } as never;
    expect((await handleLiveThreadActivityApi(new Request(f.url()), f.url(), 'GET', auth(delegate), f.context))?.status).toBe(200);
    f.context.workspaceDelegationStore = { findActiveDelegation: () => null } as never;
    expect((await handleLiveThreadActivityApi(new Request(f.url()), f.url(), 'GET', auth(delegate), f.context))?.status).toBe(403);
  });
});

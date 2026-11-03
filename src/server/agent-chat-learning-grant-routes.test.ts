import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

import { LearningGrantMappingStore } from '../agent-chat/learning-grant-mappings';
import { handleLearningGrantRoute } from './agent-chat-learning-grant-routes';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// Synthetic identities and grant ids only.
const learner = nip19.npubEncode(getPublicKey(generateSecretKey()));
const GRANT = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

function fixture(subscriptions: Array<Record<string, unknown>>) {
  const dir = mkdtempSync(join(tmpdir(), 'learning-grants-'));
  dirs.push(dir);
  const store = new LearningGrantMappingStore(join(dir, 'db.sqlite'));
  const agents: Record<string, any> = { tutor: { agentId: 'tutor', botNpub: 'npub1tutorbot', managedByNpub: 'npub1manager' } };
  const manager = {
    getAgentForManager: (agentId: string, npub: string) => (npub === 'npub1manager' ? agents[agentId] ?? null : null),
    listForManager: (npub: string) => (npub === 'npub1manager' ? subscriptions : []),
  } as any;
  const call = (method: string, body?: unknown, agentId = 'tutor', managerNpub = 'npub1manager') => {
    const url = new URL(`http://autopilot.test/api/agent-chat/agents/${agentId}/learning-grants`);
    return handleLearningGrantRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url, manager, { managerNpub }, store);
  };
  return { store, call };
}

const sub = (patch: Record<string, unknown> = {}) => ({ subscriptionId: 's-1', workspaceId: 'ws-1', backendBaseUrl: 'https://tower.example/', botNpub: 'npub1tutorbot', agentProfileId: 'tutor', ...patch });

describe('learning grant manager routes', () => {
  test('sets, reads and removes the grant for the Tower of the manager\'s own workspace subscription', async () => {
    const f = fixture([sub()]);
    const saved = await (await f.call('PUT', { workspaceId: 'ws-1', grantId: GRANT, learnerNpub: learner }))!.json();
    expect(saved.mapping).toMatchObject({ agentId: 'tutor', botNpub: 'npub1tutorbot', towerOrigin: 'https://tower.example', workspaceId: 'ws-1', grantId: GRANT, learnerNpub: learner });
    expect(f.store.forBot('npub1tutorbot', 'https://tower.example')?.grantId).toBe(GRANT);
    expect((await (await f.call('GET'))!.json()).mappings).toHaveLength(1);
    expect(await (await f.call('DELETE', { workspaceId: 'ws-1' }))!.json()).toEqual({ removed: true, towerOrigin: 'https://tower.example' });
    expect(f.store.forBot('npub1tutorbot', 'https://tower.example')).toBeNull();
  });

  test('refuses other managers, unknown workspaces, invalid grants or learners, and ambiguous Towers', async () => {
    const f = fixture([sub(), sub({ subscriptionId: 's-2', workspaceId: 'ws-2', backendBaseUrl: 'https://a.example' }),
      sub({ subscriptionId: 's-3', workspaceId: 'ws-2', backendBaseUrl: 'https://b.example' })]);
    expect((await f.call('PUT', { workspaceId: 'ws-1', grantId: GRANT }, 'tutor', 'npub1stranger'))!.status).toBe(404);
    expect((await f.call('PUT', { workspaceId: 'ws-9', grantId: GRANT }))!.status).toBe(404);
    expect((await f.call('PUT', { workspaceId: 'ws-1', grantId: 'not-a-uuid' }))!.status).toBe(400);
    expect((await f.call('PUT', { workspaceId: 'ws-1', grantId: GRANT, learnerNpub: 'npub1bogus' }))!.status).toBe(400);
    expect((await f.call('PUT', { workspaceId: 'ws-2', grantId: GRANT }))!.status).toBe(409);
    expect((await f.call('PUT', { grantId: GRANT }))!.status).toBe(400);
    expect(f.store.listForAgent('tutor')).toEqual([]);
  });

  test('other paths are not handled here', async () => {
    const f = fixture([sub()]);
    const url = new URL('http://autopilot.test/api/agent-chat/agents/tutor');
    expect(await handleLearningGrantRoute(new Request(url), url, {} as any, { managerNpub: 'npub1manager' }, f.store)).toBeNull();
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateSecretKey, getPublicKey, nip19, verifyEvent } from 'nostr-tools';

import { LearningGrantMappingStore } from './learning-grant-mappings';
import { authorizeLearningPipelineRoute } from './learning-pipeline-route';

// Synthetic identities and grant ids only.
const GRANT = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'learning-route-'));
  dirs.push(dir);
  const grants = new LearningGrantMappingStore(join(dir, 'db.sqlite'));
  const secret = generateSecretKey();
  const botNpub = nip19.npubEncode(getPublicKey(secret));
  const requests: Request[] = [];
  const towerTransport = { prepare: async (url: string) => url, fetch: async (input: string | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return Response.json({ mastery: [] });
  } };
  const request = {
    agent: { agentId: 'tutor', botNpub }, botIdentity: { botNpub, botPubkeyHex: getPublicKey(secret), botSecret: secret, towerTransport },
    subscription: { subscriptionId: 'sub-1', backendConnectionId: 'backend-1', backendBaseUrl: 'https://tower.example', workspaceId: 'ws-1' },
  } as any;
  return { grants, request, requests, botNpub };
}
const decode = (authorization: string | null) => JSON.parse(Buffer.from(String(authorization).replace(/^Nostr /, ''), 'base64').toString());

describe('learning router precheck', () => {
  test('without an operator-set grant the request is unchanged (implicit learner selection)', async () => {
    const t = setup();
    expect(await authorizeLearningPipelineRoute(t.request, t.grants)).toEqual({ grantId: null });
    expect(t.requests[0]!.headers.get('x-learning-grant-id')).toBeNull();
    expect(decode(t.requests[0]!.headers.get('authorization')).tags.some((tag: string[]) => tag[0] === 'learning_grant_id')).toBe(false);
  });

  test('with an operator-set grant the header and the signed tag name the same delegation', async () => {
    const t = setup();
    t.grants.save({ agentId: 'tutor', botNpub: t.botNpub, towerOrigin: 'https://tower.example', workspaceId: 'ws-1', grantId: GRANT, learnerNpub: null, managedByNpub: 'npub1manager' });
    expect(await authorizeLearningPipelineRoute(t.request, t.grants)).toEqual({ grantId: GRANT });
    const sent = t.requests[0]!;
    expect(new URL(sent.url).pathname).toBe('/api/v4/learning/mastery');
    expect(sent.headers.get('x-learning-grant-id')).toBe(GRANT);
    const event = decode(sent.headers.get('authorization'));
    expect(verifyEvent(event)).toBe(true);
    expect(event.kind).toBe(27235);
    expect(event.tags).toContainEqual(['learning_grant_id', GRANT]);
    expect(event.tags).toContainEqual(['method', 'GET']);
  });

  test('a grant mapped for another Tower is not used', async () => {
    const t = setup();
    t.grants.save({ agentId: 'tutor', botNpub: t.botNpub, towerOrigin: 'https://other.example', workspaceId: 'ws-1', grantId: GRANT, learnerNpub: null, managedByNpub: 'npub1manager' });
    expect(await authorizeLearningPipelineRoute(t.request, t.grants)).toEqual({ grantId: null });
  });
});

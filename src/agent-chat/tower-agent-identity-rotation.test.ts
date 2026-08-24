import { createHash } from 'node:crypto';

import { describe, expect, test } from 'bun:test';
import { generateSecretKey, getPublicKey, nip19, verifyEvent } from 'nostr-tools';

import { buildTowerAgentRotationRequest, signTowerAgentRotationHttpRequest } from './tower-agent-identity-rotation';

describe('Tower agent identity rotation wire contract', () => {
  test('builds the deterministic kind-33359 proof and body-bound old-key NIP-98 event', () => {
    const oldSecret = generateSecretKey();
    const newSecret = generateSecretKey();
    try {
      const oldNpub = nip19.npubEncode(getPublicKey(oldSecret));
      const newNpub = nip19.npubEncode(getPublicKey(newSecret));
      const request = buildTowerAgentRotationRequest({
        context: { towerOrigin: 'https://tower.test', workspaceId: 'workspace-1', actorId: 'actor-1', subscriptionCount: 2 },
        rotationId: 'rotation-1', oldNpub, newNpub, createdAt: 1_786_579_200, expiresAt: 1_786_579_800, newSecretKey: newSecret,
      });
      const body = JSON.parse(request.body);
      expect(Object.keys(body)).toEqual(['rotation_id', 'old_npub', 'new_npub', 'proof']);
      expect(body.proof.kind).toBe(33359);
      expect(body.proof.tags).toEqual([
        ['protocol', 'flightdeck_pg_agent_identity_rotation'], ['tower_origin', 'https://tower.test'],
        ['workspace_id', 'workspace-1'], ['actor_id', 'actor-1'], ['old_npub', oldNpub], ['new_npub', newNpub],
        ['rotation_id', 'rotation-1'], ['expires_at', '1786579800'],
      ]);
      expect(body.proof.content).toBe(JSON.stringify({ protocol: 'flightdeck_pg_agent_identity_rotation', version: 1, tower_origin: 'https://tower.test', workspace_id: 'workspace-1', actor_id: 'actor-1', old_npub: oldNpub, new_npub: newNpub, rotation_id: 'rotation-1', created_at: 1_786_579_200, expires_at: 1_786_579_800 }));
      expect(verifyEvent(body.proof)).toBe(true);

      const authorization = signTowerAgentRotationHttpRequest(request, oldSecret, 1_786_579_201);
      const nip98 = JSON.parse(Buffer.from(authorization.slice('Nostr '.length), 'base64').toString('utf8'));
      expect(verifyEvent(nip98)).toBe(true);
      expect(nip19.npubEncode(nip98.pubkey)).toBe(oldNpub);
      expect(nip98.tags).toEqual([['u', request.url], ['method', 'POST'], ['payload', createHash('sha256').update(request.body).digest('hex')]]);
    } finally {
      oldSecret.fill(0);
      newSecret.fill(0);
    }
  });
});

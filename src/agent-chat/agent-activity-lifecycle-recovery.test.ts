import { expect, test } from 'bun:test';
import { createActivityProfileRecovery } from './agent-activity-lifecycle-recovery';

test('recovers the saved profile signer through a shared subscription and rejects changed routing', async () => {
  const turn = { turnId: 'turn', agentNpub: 'builder', agentId: 'Builder', workspaceId: 'workspace',
    channelId: 'channel', threadId: 'thread' } as any;
  const request = { ...turn, backendBaseUrl: 'https://tower.test', appNpub: 'app' } as any;
  const identity = { botNpub: 'builder', botPubkeyHex: 'public', botSecret: new Uint8Array([1]) };
  const used: string[] = [];
  const recover = createActivityProfileRecovery({ store: { get: () => turn },
    resolveTransport: () => ({ backendBaseUrl: 'https://tower.test', workspaceId: 'workspace', appNpub: 'app' }),
    withProfileIdentity: async (_record, operation) => operation(identity) });
  await recover(request, async (value) => { used.push(value.botNpub); });
  for (const change of [{ workspaceId: 'other' }, { threadId: 'other' }, { agentNpub: 'other' },
    { backendBaseUrl: 'https://other.test' }, { appNpub: 'other' }]) {
    await recover({ ...request, ...change }, async () => { used.push('wrong'); });
  }
  expect(used).toEqual(['builder']);
});

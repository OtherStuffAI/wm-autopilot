import { describe, expect, test } from 'bun:test';

import { parseAgentConnectPackage } from './agent-chat-connect-import-card.js';

describe('Agent Connect browser preflight', () => {
  test('accepts the current Flight Deck v6 descriptor package', () => {
    const payload = {
      kind: 'coworker_agent_connect',
      version: 6,
      protocol: 'flightdeck_pg',
      generated_at: '2026-07-26T00:00:00.000Z',
      service: { direct_https_url: 'https://tower.example.com' },
      auth: { scheme: 'NIP-98', app_npub: 'npub1app' },
      workspace_descriptor: {
        type: 'wingman_workspace_locator',
        identity: {
          tower_service_npub: 'npub1tower',
          workspace_service_npub: 'npub1workspace_service',
          workspace_owner_npub: 'npub1owner',
          workspace_id: 'workspace-1',
          app_npub: 'npub1app',
        },
      },
    };

    expect(JSON.parse(parseAgentConnectPackage(JSON.stringify(payload)))).toEqual(payload);
  });

  test('continues to accept legacy v5 packages', () => {
    const payload = {
      kind: 'coworker_agent_connect',
      version: 5,
      service: { direct_https_url: 'https://tower.example.com' },
      workspace: { owner_npub: 'npub1owner' },
      app: { app_npub: 'npub1app' },
      connection_token: 'token',
    };
    expect(JSON.parse(parseAgentConnectPackage(JSON.stringify(payload)))).toEqual(payload);
  });
});

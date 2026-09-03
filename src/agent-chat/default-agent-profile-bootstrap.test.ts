import { describe, expect, test } from 'bun:test';

import type { AgentDefinitionRecord } from './types';
import { ensureDefaultAgentProfileForManager } from './default-agent-profile-bootstrap';

const managerNpub = 'npub1manager000000000000000000000000000000000000000000000000fallback';

function profile(agentId: string, overrides: Partial<AgentDefinitionRecord> = {}): AgentDefinitionRecord {
  return {
    agentId,
    label: agentId,
    botNpub: `npub1${agentId}`,
    workspaceOwnerNpub: managerNpub,
    groupNpubs: [],
    workingDirectory: '/workspace',
    capabilities: ['chat_intercept'],
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    managedByNpub: managerNpub,
    ...overrides,
  };
}

describe('default Agent Profile bootstrap', () => {
  test('leaves an existing manager default unchanged', async () => {
    const existing = profile('lara');
    let created = false;
    const result = await ensureDefaultAgentProfileForManager({
      manager: {
        getDefaultAgentForManager: () => existing,
        listAgentsForManager: () => [existing],
        setDefaultAgentForManager: () => existing,
        createAgentProfileForManager: async () => { created = true; throw new Error('unexpected'); },
      },
      managerNpub,
      instanceName: 'lara',
      workingDirectory: '/workspace',
      harness: 'codex',
      profileIdExists: () => true,
      publishProfile: async () => undefined,
    });

    expect(result).toEqual({ status: 'already_configured', profileId: 'lara', publicationWarning: null });
    expect(created).toBe(false);
  });

  test('repairs a missing default from the oldest active manager profile', async () => {
    const older = profile('older');
    const newer = profile('newer', { createdAt: '2026-02-01T00:00:00.000Z' });
    let selected = '';
    const result = await ensureDefaultAgentProfileForManager({
      manager: {
        getDefaultAgentForManager: () => null,
        listAgentsForManager: () => [newer, older],
        setDefaultAgentForManager: (agentId) => { selected = agentId; return older; },
        createAgentProfileForManager: async () => { throw new Error('unexpected'); },
      },
      managerNpub,
      instanceName: 'lara',
      workingDirectory: '/workspace',
      harness: 'codex',
      profileIdExists: () => false,
      publishProfile: async () => undefined,
    });

    expect(selected).toBe('older');
    expect(result.status).toBe('default_repaired');
  });

  test('creates and publishes a default profile with a collision-safe id', async () => {
    let createInput: Record<string, unknown> | null = null;
    let published = false;
    const createdProfile = profile('lara-fallback');
    const result = await ensureDefaultAgentProfileForManager({
      manager: {
        getDefaultAgentForManager: () => null,
        listAgentsForManager: () => [],
        setDefaultAgentForManager: () => createdProfile,
        createAgentProfileForManager: async (input) => {
          createInput = input as unknown as Record<string, unknown>;
          return { agent: createdProfile, signedProfileEvent: {} as never };
        },
      },
      managerNpub,
      instanceName: 'Lara',
      workingDirectory: '/workspace',
      harness: 'codex',
      profileIdExists: (profileId) => profileId === 'lara',
      publishProfile: async () => { published = true; },
    });

    expect(createInput).toMatchObject({
      agentId: 'lara-fallback',
      managedByNpub: managerNpub,
      workspaceOwnerNpub: managerNpub,
      workingDirectory: '/workspace',
      harness: 'codex',
    });
    expect(published).toBe(true);
    expect(result).toEqual({ status: 'created', profileId: 'lara-fallback', publicationWarning: null });
  });

  test('keeps a usable local default when public profile publication fails', async () => {
    const createdProfile = profile('lara');
    const result = await ensureDefaultAgentProfileForManager({
      manager: {
        getDefaultAgentForManager: () => null,
        listAgentsForManager: () => [],
        setDefaultAgentForManager: () => createdProfile,
        createAgentProfileForManager: async () => ({ agent: createdProfile, signedProfileEvent: {} as never }),
      },
      managerNpub,
      instanceName: 'lara',
      workingDirectory: '/workspace',
      harness: 'codex',
      profileIdExists: () => false,
      publishProfile: async () => { throw new Error('relay unavailable'); },
    });

    expect(result).toEqual({ status: 'created', profileId: 'lara', publicationWarning: 'relay unavailable' });
  });
});

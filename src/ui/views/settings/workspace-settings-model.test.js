import { describe, expect, test } from 'bun:test';
import { buildWorkspaceSettingsModel } from './workspace-settings-model.js';

const bot = { agentId: 'rick', label: 'Rick', enabled: true, directChat: { enabled: true } };
function subscription(id, workspaceId = 'one', backendBaseUrl = 'https://tower.example') {
  return { subscriptionId: id, workspaceId, backendBaseUrl, workspaceName: 'Named workspace',
    healthStatus: 'healthy', candidateAgents: [bot] };
}

describe('workspace settings hierarchy', () => {
  test('groups multiple bot connections under one workspace and permits the same bot in another workspace', () => {
    const result = buildWorkspaceSettingsModel([subscription('a'), subscription('b'), subscription('c', 'two')], { agents: [bot] }, []);
    expect(result).toHaveLength(1);
    expect(result[0].workspaces).toHaveLength(2);
    expect(result[0].workspaces[0].subscriptions).toHaveLength(2);
    expect(result[0].workspaces.map((item) => item.bots.length)).toEqual([1, 1]);
    expect(result[0].workspaces[0].name).toBe('Named workspace');
  });
  test('does not merge matching workspace IDs on different servers or unknown workspaces', () => {
    expect(buildWorkspaceSettingsModel([subscription('a'), subscription('b', 'one', 'https://other.example')], { agents: [bot] }, [])).toHaveLength(2);
    const result = buildWorkspaceSettingsModel([subscription('a', null), subscription('b', null)], { agents: [] }, []);
    expect(result[0].workspaces).toHaveLength(2);
  });
  test('uses recorded multi-bot connections without treating every local bot as a member', () => {
    const other = { ...bot, agentId: 'dakka', label: 'Dakka' };
    const result = buildWorkspaceSettingsModel([subscription('a')], { agents: [bot, other, { ...bot, agentId: 'unrelated' }],
      workspaceBotConnections: [{ agentId: 'dakka', subscriptionId: 'a', status: 'verified' }] }, []);
    expect(result[0].workspaces[0].bots.map((item) => item.agentId).sort()).toEqual(['dakka', 'rick']);
  });
  test('does not cache connection secrets or profile runtime context', () => {
    const input = { ...subscription('a'), connectionToken: 'SECRET', wrappedGroupKeysJson: 'SECRET', workspaceContext: 'SECRET',
      profileWorkspace: { workspace: { workspaceContext: 'SECRET' } } };
    expect(JSON.stringify(buildWorkspaceSettingsModel([input], { agents: [bot] }, []))).not.toContain('SECRET');
  });
});

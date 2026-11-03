// Synthetic per-bot delivery paths for UI tests and isolated previews. Identities are generic placeholders.
const npub = (fill) => `npub1${fill.repeat(58).slice(0, 58)}`;
const base = {
  backendBaseUrl: 'https://tower.example.invalid', connection: 'connected', health: 'healthy', lifecycle: 'active',
  sharedSubscriptionId: null, inbox: null, error: null, statusDetail: null,
};

export const BOT_SUBSCRIPTION_FIXTURE_ROWS = Object.freeze([
  { ...base, rowId: 'profile:sub-inbox-a', kind: 'profile', status: 'inbox', subscriptionId: 'sub-inbox-a',
    workspaceId: 'ws-alpha', workspaceName: 'Example Workspace', agentId: 'agent-alpha', botLabel: 'Example Bot',
    botNpub: npub('a'), servedAgentIds: ['agent-alpha'], lastSuccessfulPollAt: '2026-11-03T03:58:00.000Z',
    inbox: { towerSubscriptionEstablished: true, floorAt: '2026-11-02T04:00:00.000Z', lastOkAt: '2026-11-03T03:58:00.000Z', lastGapAt: null } },
  { ...base, rowId: 'profile:sub-inbox-b', kind: 'profile', status: 'inbox', subscriptionId: 'sub-inbox-b',
    workspaceId: 'ws-alpha', workspaceName: 'Example Workspace', agentId: 'agent-beta', botLabel: 'Example Bot',
    botNpub: npub('b'), servedAgentIds: ['agent-beta'], lastSuccessfulPollAt: '2026-11-03T03:57:00.000Z',
    inbox: { towerSubscriptionEstablished: true, floorAt: '2026-11-02T05:00:00.000Z', lastOkAt: '2026-11-03T03:57:00.000Z', lastGapAt: '2026-11-03T01:00:00.000Z' } },
  { ...base, rowId: 'shared:sub-shared', kind: 'shared', status: 'legacy_shared', subscriptionId: 'sub-shared',
    workspaceId: 'ws-alpha', workspaceName: 'Example Workspace', agentId: null, botLabel: null,
    botNpub: npub('c'), servedAgentIds: ['agent-gamma'], lastSuccessfulPollAt: '2026-11-03T03:59:00.000Z' },
  { ...base, rowId: 'served:sub-shared:agent-gamma', kind: 'served_by_shared', status: 'not_migrated', subscriptionId: 'sub-shared',
    sharedSubscriptionId: 'sub-shared', workspaceId: 'ws-alpha', workspaceName: 'Example Workspace', agentId: 'agent-gamma',
    botLabel: 'Shared Helper', botNpub: npub('d'), servedAgentIds: ['agent-gamma'], statusDetail: 'Served by the shared legacy subscription.',
    lastSuccessfulPollAt: '2026-11-03T03:59:00.000Z' },
  { ...base, rowId: 'profile:sub-blocked', kind: 'profile', status: 'blocked', subscriptionId: 'sub-blocked',
    workspaceId: 'ws-beta', workspaceName: null, agentId: 'agent-delta', botLabel: 'Blocked Bot', botNpub: npub('e'),
    servedAgentIds: ['agent-delta'], statusDetail: 'agent_inbox_halt', lastSuccessfulPollAt: null, connection: 'error', health: 'degraded',
    inbox: { towerSubscriptionEstablished: false, floorAt: null, lastOkAt: null, lastGapAt: null },
    error: { code: 'agent_inbox_halt', errorClass: 'auth', at: '2026-11-03T02:00:00.000Z' } },
  { ...base, rowId: 'profile:sub-off', kind: 'profile', status: 'disconnected', subscriptionId: 'sub-off',
    workspaceId: 'ws-gamma', workspaceName: 'Paused Workspace', agentId: 'agent-epsilon', botLabel: 'Paused Bot', botNpub: npub('f'),
    servedAgentIds: ['agent-epsilon'], statusDetail: 'disabled', connection: 'disabled', health: 'disabled', lastSuccessfulPollAt: null },
]);

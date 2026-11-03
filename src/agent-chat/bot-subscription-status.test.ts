import { describe, expect, test } from 'bun:test';

import { buildBotSubscriptionRows } from './bot-subscription-status';

const sub = (patch: Record<string, unknown>) => ({
  subscriptionId: 'sub', workspaceId: 'ws-1', backendBaseUrl: 'https://tower', botNpub: 'npub1shared', sseStatus: 'connected', healthStatus: 'healthy',
  lifecycleStatus: 'active', agentProfileId: null, lastErrorCode: null, lastEventPollErrorCode: null, lastEventPollOkAt: '2026-11-03T03:40:00.000Z',
  lastRoutingResult: null, ...patch,
}) as any;
const agent = (agentId: string, botNpub: string) => ({ agentId, label: agentId[0]!.toUpperCase() + agentId.slice(1), botNpub }) as any;
const inbox = (patch: Record<string, unknown> = {}) => ({ mode: 'inbox_required', towerSubscriptionId: 'tower-sub', cursor: 'SECRET-CURSOR', floorAt: '2026-11-02T03:23:43.788Z',
  lastOkAt: '2026-11-03T03:41:00.000Z', lastErrorCode: null, lastErrorClass: null, lastErrorAt: null, lastGap: null, ...patch }) as any;

describe('per-bot subscription rows', () => {
  const agents = [agent('dakkabot', 'npub1dakka'), agent('brick', 'npub1brick'), agent('piper', 'npub1piper'), agent('mick', 'npub1mick'), agent('legacybot', 'npub1legacy')];
  const subscriptions = [
    sub({ subscriptionId: 'shared', lastRoutingResult: { at: '2026-11-03T03:47:59.990Z', details: { rejected_audience: [{ npub: 'npub1mick', code: 'inactive_or_unknown_workspace_member' }] } } }),
    sub({ subscriptionId: 'dakka', agentProfileId: 'dakkabot', botNpub: 'npub1dakka' }),
    sub({ subscriptionId: 'brick', agentProfileId: 'brick', botNpub: 'npub1brick', sseStatus: 'backoff', lastErrorCode: 'agent_inbox_halt:agent_identity_required' }),
    sub({ subscriptionId: 'legacy', agentProfileId: 'legacybot', botNpub: 'npub1legacy' }),
    sub({ subscriptionId: 'old', agentProfileId: 'piper', botNpub: 'npub1piper', lifecycleStatus: 'locally_disconnected', sseStatus: 'disabled' }),
  ];
  const states: Record<string, any> = { dakka: inbox(), brick: inbox({ lastErrorCode: 'agent_identity_required', lastErrorClass: 'auth' }) };
  const rows = buildBotSubscriptionRows({
    subscriptions, agents,
    inboxState: (id) => states[id] ?? null,
    sharedAudience: () => [agents[2], agents[3], agents[4]],
    workspaceName: (record) => (record.subscriptionId === 'legacy' ? null : 'Other Stuff'),
  });
  const byId = Object.fromEntries(rows.map((row) => [row.rowId, row]));

  test('one row per real delivery path; migrated bots are only on their own subscription', () => {
    expect(rows.map((row) => row.rowId).sort()).toEqual([
      'profile:brick', 'profile:dakka', 'profile:legacy', 'profile:old', 'served:shared:legacybot', 'served:shared:mick', 'served:shared:piper', 'shared:shared',
    ]);
    expect(byId['shared:shared']).toMatchObject({ kind: 'shared', status: 'legacy_shared', servedAgentIds: ['piper', 'mick', 'legacybot'] });
  });

  test('status is derived from stored state, never optimistic', () => {
    expect(byId['profile:dakka']).toMatchObject({ status: 'inbox', inbox: { towerSubscriptionEstablished: true, floorAt: '2026-11-02T03:23:43.788Z' } });
    expect(byId['profile:brick']).toMatchObject({ status: 'blocked', statusDetail: 'agent_inbox_halt:agent_identity_required', error: { code: 'agent_inbox_halt:agent_identity_required' } });
    expect(byId['profile:legacy']).toMatchObject({ status: 'legacy_profile', inbox: null, workspaceName: null });
    expect(byId['profile:old']).toMatchObject({ status: 'disconnected' });
    expect(byId['served:shared:piper']).toMatchObject({ status: 'not_migrated', sharedSubscriptionId: 'shared', agentId: 'piper' });
    expect(byId['served:shared:mick']).toMatchObject({ status: 'blocked', error: { code: 'inactive_or_unknown_workspace_member', errorClass: 'audience' } });
  });

  test('rows never carry inbox cursors', () => {
    expect(JSON.stringify(rows)).not.toContain('SECRET-CURSOR');
  });

  test('an inbox subscription without an established Tower subscription is blocked, not isolated', () => {
    const [row] = buildBotSubscriptionRows({ subscriptions: [sub({ subscriptionId: 'x', agentProfileId: 'dakkabot', botNpub: 'npub1dakka' })], agents,
      inboxState: () => inbox({ towerSubscriptionId: null, lastErrorCode: 'agent_inbox_unsupported' }), sharedAudience: () => [], workspaceName: () => null });
    expect(row).toMatchObject({ status: 'blocked', statusDetail: 'agent_inbox_unsupported' });
  });
});

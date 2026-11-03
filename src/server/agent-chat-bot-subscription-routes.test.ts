import { describe, expect, test } from 'bun:test';

import { handleBotSubscriptionRoute } from './agent-chat-bot-subscription-routes';

const scope = { managerNpub: 'npub1manager' };
function manager(classification: (id: string) => Promise<any>) {
  const calls: string[] = [];
  return {
    calls,
    api: {
      listBotSubscriptionsForManager: (npub: string) => { calls.push(`list:${npub}`); return [{ rowId: 'profile:a' }] as any; },
      readAgentInboxClassificationForManager: async (id: string, npub: string) => { calls.push(`classify:${id}:${npub}`); return classification(id); },
    },
  };
}
const get = (path: string, method = 'GET') => { const url = new URL(`http://autopilot.test${path}`); return [new Request(url, { method }), url] as const; };

describe('per-bot subscription routes (read-only)', () => {
  test('lists rows for the caller manager only', async () => {
    const m = manager(async () => null);
    const response = await handleBotSubscriptionRoute(...get('/api/agent-chat/bot-subscriptions'), m.api, scope);
    expect(await response!.json()).toEqual({ rows: [{ rowId: 'profile:a' }] });
    expect(m.calls).toEqual(['list:npub1manager']);
  });

  test('classification reports the Tower profile, 404 for unknown and real errors with status', async () => {
    const m = manager(async (id) => {
      if (id === 'missing') return null;
      if (id === 'down') throw Object.assign(new Error('Tower unavailable'), { status: 503, code: 'authorization_unavailable' });
      return { profile: 'notification_only', checkedAt: '2026-11-03T04:00:00.000Z' };
    });
    const ok = await handleBotSubscriptionRoute(...get('/api/agent-chat/subscriptions/sub-1/agent-inbox/classification'), m.api, scope);
    expect(await ok!.json()).toEqual({ subscriptionId: 'sub-1', classified: true, profile: 'notification_only', checkedAt: '2026-11-03T04:00:00.000Z' });
    expect((await handleBotSubscriptionRoute(...get('/api/agent-chat/subscriptions/missing/agent-inbox/classification'), m.api, scope))!.status).toBe(404);
    const down = await handleBotSubscriptionRoute(...get('/api/agent-chat/subscriptions/down/agent-inbox/classification'), m.api, scope);
    expect([down!.status, await down!.json()]).toEqual([503, { error: 'Tower unavailable', code: 'authorization_unavailable' }]);
  });

  test('never handles writes or unrelated paths', async () => {
    const m = manager(async () => ({ profile: null, checkedAt: 'x' }));
    expect(await handleBotSubscriptionRoute(...get('/api/agent-chat/bot-subscriptions', 'POST'), m.api, scope)).toBeNull();
    expect(await handleBotSubscriptionRoute(...get('/api/agent-chat/subscriptions/sub-1/agent-inbox'), m.api, scope)).toBeNull();
    expect(m.calls).toEqual([]);
  });
});

import { afterEach, describe, expect, test } from 'bun:test';

import { refreshAgentChatSubscriptionAudiences } from './agent-chat.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Agent Chat subscription audience refresh', () => {
  test('posts the authenticated bulk audience refresh action', async () => {
    let request = null;
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return Response.json({ subscriptions: [], failures: [] });
    };

    await refreshAgentChatSubscriptionAudiences();

    expect(request).toEqual({
      url: '/api/agent-chat/subscriptions/actions/refresh-audiences',
      options: { method: 'POST', credentials: 'include' },
    });
  });

  test('includes actionable Tower failure details', async () => {
    globalThis.fetch = async () => Response.json({
      error: 'Failed to refresh 1 Flight Deck subscription audience.',
      failures: [{ subscriptionId: 'sub-1', error: 'Tower rejected Piper.' }],
    }, { status: 502 });

    expect(refreshAgentChatSubscriptionAudiences()).rejects.toThrow(
      'Failed to refresh 1 Flight Deck subscription audience. Tower rejected Piper.',
    );
  });
});

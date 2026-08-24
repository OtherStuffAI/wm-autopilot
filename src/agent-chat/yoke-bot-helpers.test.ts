import { describe, expect, test } from 'bun:test';

import { loadYokeBotHelpers } from './yoke-bot-helpers';

describe('loadYokeBotHelpers routing contract', () => {
  test('exposes shared routing helpers from Yoke', async () => {
    const helpers = await loadYokeBotHelpers();

    expect(typeof helpers.normalizeThreadId).toBe('function');
    expect(typeof helpers.normalizeChannelParticipants).toBe('function');
    expect(typeof helpers.normalizeChatRoutingContext).toBe('function');
  });

  test('normalizeChatRoutingContext resolves thread and participants through the shared Yoke path', async () => {
    const helpers = await loadYokeBotHelpers();
    const ownerNpub = 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq9e75rs';
    const botNpub = 'npub1lllllllllllllllllllllllllllllllls5s6g6';

    const routing = helpers.normalizeChatRoutingContext(
      {
        chatMessage: {
          record_id: 'msg-child',
          channel_id: 'chan-1',
          parent_message_id: 'msg-root',
        },
        channel: {
          record_id: 'chan-1',
          owner_npub: ownerNpub,
          participant_npubs: [botNpub, ownerNpub, botNpub],
        },
      },
      {
        lookupMessage: (id: string) => id === 'msg-root'
          ? { record_id: 'msg-root', parent_message_id: null }
          : null,
      },
    );

    expect(routing.thread_id).toBe('msg-root');
    expect(routing.participant_npubs).toEqual([botNpub, ownerNpub].sort());
  });
});

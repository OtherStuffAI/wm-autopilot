import { expect, test } from 'bun:test';
import { hydrateDirectChatThread, hydrateFlightDeckPgChatEvent } from './direct-chat-tower-hydration';

test('Agent Direct Chat hydration reads every authoritative thread page', async () => {
  const cursors: Array<string | null | undefined> = [];
  const result = await hydrateDirectChatThread({
    subscription: { workspaceId: 'workspace', backendBaseUrl: 'https://tower', sourceAppNpub: 'app' } as never,
    botIdentity: {} as never,
    channelId: 'channel',
    threadId: 'thread',
  }, {
    fetchChannel: async () => ({ id: 'channel', metadata: { agent_chat: { enabled: true } } }),
    fetchMessages: async (input) => {
      cursors.push(input.cursor);
      return input.cursor
        ? { messages: [{ id: 'm2', thread_id: 'thread' }], next_cursor: null }
        : { messages: [{ id: 'm1', thread_id: 'thread' }], next_cursor: 'page-2' };
    },
  });
  expect(cursors).toEqual([null, 'page-2']);
  expect(result.messages.map((message) => message.id)).toEqual(['m1', 'm2']);
});

test('Agent Direct Chat hydration falls back when Tower has no single-channel route', async () => {
  const result = await hydrateDirectChatThread({
    subscription: { workspaceId: 'workspace', backendBaseUrl: 'https://tower', sourceAppNpub: 'app' } as never,
    botIdentity: {} as never,
    channelId: 'channel',
    threadId: 'thread',
  }, {
    fetchChannel: async () => { throw Object.assign(new Error('Not Found'), { status: 404 }); },
    fetchMessages: async () => ({
      messages: [{ id: 'm1', thread_id: 'thread', scope_id: 'scope' }],
      next_cursor: null,
    }),
  });

  expect(result.channel).toEqual({ id: 'channel', workspace_id: 'workspace', scope_id: 'scope' });
  expect(result.messages.map((message) => message.id)).toEqual(['m1']);
});

test('Agent Direct Chat hydration still rejects non-404 channel failures', async () => {
  const failure = Object.assign(new Error('Forbidden'), { status: 403 });
  await expect(hydrateDirectChatThread({
    subscription: { workspaceId: 'workspace', backendBaseUrl: 'https://tower', sourceAppNpub: 'app' } as never,
    botIdentity: {} as never,
    channelId: 'channel',
    threadId: 'thread',
  }, {
    fetchChannel: async () => { throw failure; },
    fetchMessages: async () => ({ messages: [], next_cursor: null }),
  })).rejects.toBe(failure);
});

test('PG message event hydration pages its authoritative thread to the exact trigger', async () => {
  const requestedThreadIds: Array<string | null | undefined> = [];
  const result = await hydrateFlightDeckPgChatEvent({
    subscription: { workspaceId: 'workspace', backendBaseUrl: 'https://tower', sourceAppNpub: 'app' } as never,
    botIdentity: {} as never,
    channelId: 'channel',
    event: {
      entity_type: 'message',
      entity_id: 'trigger',
      payload: { thread_id: 'thread' },
      refetch: { route: '/api/v4/flightdeck-pg/workspaces/workspace/channels/channel/messages?thread_id=thread' },
    },
    includeChannel: false,
  }, {
    fetchChannel: async () => { throw new Error('channel fetch should not be needed'); },
    fetchMessages: async (input) => {
      requestedThreadIds.push(input.threadId);
      return input.cursor
        ? { messages: [{ id: 'trigger', thread_id: 'thread', created_at: '2026-07-28T00:00:00.000Z' }], next_cursor: null }
        : { messages: [{ id: 'historical', thread_id: 'thread', created_at: '2026-07-26T00:00:00.000Z' }], next_cursor: 'page-2' };
    },
  });

  expect(requestedThreadIds).toEqual(['thread', 'thread']);
  expect(result.message?.id).toBe('trigger');
  expect(result.messages.map((message) => message.id)).toEqual(['historical', 'trigger']);
});

test('PG message event hydration never substitutes an unrelated last message', async () => {
  const result = await hydrateFlightDeckPgChatEvent({
    subscription: { workspaceId: 'workspace', backendBaseUrl: 'https://tower', sourceAppNpub: 'app' } as never,
    botIdentity: {} as never,
    channelId: 'channel',
    event: { entity_type: 'message', entity_id: 'missing', payload: { thread_id: 'thread' } },
    includeChannel: false,
  }, {
    fetchChannel: async () => ({ id: 'channel' }),
    fetchMessages: async () => ({
      messages: [{ id: 'unrelated', thread_id: 'thread', created_at: '2026-07-28T00:00:00.000Z' }],
      next_cursor: null,
    }),
  });

  expect(result.message).toBeNull();
});

test('PG thread event hydration selects its referenced trigger deterministically', async () => {
  const result = await hydrateFlightDeckPgChatEvent({
    subscription: { workspaceId: 'workspace', backendBaseUrl: 'https://tower', sourceAppNpub: 'app' } as never,
    botIdentity: {} as never,
    channelId: 'channel',
    event: {
      entity_type: 'thread',
      entity_id: 'thread',
      payload: { unarchived_by_message_id: 'trigger' },
    },
    includeChannel: false,
  }, {
    fetchChannel: async () => ({ id: 'channel' }),
    fetchMessages: async () => ({
      messages: [
        { id: 'newer', thread_id: 'thread', created_at: '2026-07-28T00:01:00.000Z' },
        { id: 'trigger', thread_id: 'thread', created_at: '2026-07-28T00:00:00.000Z' },
      ],
      next_cursor: null,
    }),
  });

  expect(result.message?.id).toBe('trigger');
  expect(result.messages.map((message) => message.id)).toEqual(['trigger', 'newer']);
});

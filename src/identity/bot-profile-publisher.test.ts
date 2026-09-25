import { afterEach, describe, expect, test } from 'bun:test';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';

import {
  ProfilePublicationError,
  publishBotProfileEvent,
} from './bot-profile-publisher';
import type { SignedEvent } from '../ngit/relay-publisher';

const event = finalizeEvent({
  created_at: 1,
  kind: 0,
  tags: [],
  content: '{}',
}, generateSecretKey()) as SignedEvent;
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function acceptingRelay(hostname = '127.0.0.1'): string {
  const server = Bun.serve({
    hostname,
    port: 0,
    fetch(request, server) {
      return server.upgrade(request) ? undefined : new Response('upgrade required', { status: 426 });
    },
    websocket: {
      message(socket) {
        socket.send(JSON.stringify(['OK', event.id, true, 'stored']));
      },
    },
  });
  servers.push(server);
  return `ws://${hostname}:${server.port}`;
}

describe('publishBotProfileEvent readback', () => {
  test('fails honestly when an accepted public relay does not expose the event', async () => {
    const relay = acceptingRelay('0.0.0.0').replace('0.0.0.0', 'example.test');
    const WebSocketClass = class extends WebSocket {
      constructor(_url: string | URL) {
        super(relay.replace('example.test', '127.0.0.1'));
      }
    } as typeof WebSocket;
    try {
      await publishBotProfileEvent({
        botPubkeyHex: event.pubkey,
        signedEvent: event,
        defaultRelays: [relay],
        publishOptions: { WebSocketClass, timeoutMs: 200 },
        readbackOptions: { delaysMs: [0, 0], query: async () => [] },
      });
      throw new Error('expected publication failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ProfilePublicationError);
      expect((error as ProfilePublicationError).publication).toMatchObject({
        durable: false,
        results: [{ relay, state: 'accepted', public: true, readback: 'absent', readbackAttempts: 2 }],
      });
    }
  });

  test('succeeds with one accepted and readable public relay alongside failed peers', async () => {
    const publicRelay = acceptingRelay('0.0.0.0').replace('0.0.0.0', 'public.example');
    const failedRelay = 'ws://failed.example:65530';
    const localRelay = 'ws://127.0.0.1:65531';
    const WebSocketClass = class extends WebSocket {
      constructor(url: string | URL) {
        const requested = String(url);
        super(requested === publicRelay ? publicRelay.replace('public.example', '127.0.0.1') : requested);
      }
    } as typeof WebSocket;
    const result = await publishBotProfileEvent({
      botPubkeyHex: event.pubkey,
      signedEvent: event,
      defaultRelays: [publicRelay, failedRelay, localRelay],
      publishOptions: { WebSocketClass, timeoutMs: 200 },
      readbackOptions: {
        delaysMs: [0],
        query: async (relays) => relays[0] === publicRelay ? [event] : [],
      },
    });
    expect(result.durable).toBe(true);
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ relay: publicRelay, state: 'accepted', readback: 'readable' }),
      expect.objectContaining({ relay: failedRelay, state: 'connection_failure', readback: 'not_attempted' }),
      expect.objectContaining({ relay: localRelay, state: 'connection_failure', public: false }),
    ]));
  });
});

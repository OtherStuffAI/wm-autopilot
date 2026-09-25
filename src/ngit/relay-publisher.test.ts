import { afterEach, describe, expect, test } from 'bun:test';

import {
  DEFAULT_PUBLISH_ACK_TIMEOUT_MS,
  publishToRelayWithAcknowledgement,
  type SignedEvent,
} from './relay-publisher';

const event: SignedEvent = {
  id: 'a'.repeat(64),
  pubkey: 'b'.repeat(64),
  created_at: 1,
  kind: 0,
  tags: [],
  content: '{}',
  sig: 'c'.repeat(128),
};

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function mockRelay(reply?: (socket: Bun.ServerWebSocket<unknown>, frame: unknown[]) => void): string {
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      return server.upgrade(request) ? undefined : new Response('upgrade required', { status: 426 });
    },
    websocket: {
      message(socket, data) {
        const frame = JSON.parse(String(data)) as unknown[];
        reply?.(socket, frame);
      },
    },
  });
  servers.push(server);
  return `ws://127.0.0.1:${server.port}`;
}

describe('publishToRelayWithAcknowledgement', () => {
  test('allows sixty seconds for a matching acknowledgement by default', () => {
    expect(DEFAULT_PUBLISH_ACK_TIMEOUT_MS).toBe(60_000);
  });

  test('accepts only a positive OK matching the event id', async () => {
    const relay = mockRelay((socket) => socket.send(JSON.stringify(['OK', event.id, true, 'stored'])));
    expect(await publishToRelayWithAcknowledgement(event, relay, { timeoutMs: 200 })).toEqual({
      relay,
      ok: true,
      state: 'accepted',
      acknowledgedEventId: event.id,
      message: 'stored',
    });
  });

  test('preserves a negative OK rejection message', async () => {
    const relay = mockRelay((socket) => socket.send(JSON.stringify(['OK', event.id, false, 'blocked: policy'])));
    expect(await publishToRelayWithAcknowledgement(event, relay, { timeoutMs: 200 })).toMatchObject({
      ok: false,
      state: 'rejected',
      message: 'blocked: policy',
      error: 'blocked: policy',
    });
  });

  test('reports connection failure when no relay is listening', async () => {
    const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
    const relay = `ws://127.0.0.1:${reservation.port}`;
    reservation.stop(true);
    expect(await publishToRelayWithAcknowledgement(event, relay, { timeoutMs: 200 })).toMatchObject({
      ok: false,
      state: 'connection_failure',
    });
  });

  test('times out when send succeeds but no OK arrives', async () => {
    const relay = mockRelay();
    expect(await publishToRelayWithAcknowledgement(event, relay, { timeoutMs: 30 })).toMatchObject({
      ok: false,
      state: 'timeout',
    });
  });

  test('reports a mismatched OK event id as protocol failure', async () => {
    const relay = mockRelay((socket) => socket.send(JSON.stringify(['OK', 'd'.repeat(64), true, 'stored'])));
    expect(await publishToRelayWithAcknowledgement(event, relay, { timeoutMs: 200 })).toMatchObject({
      ok: false,
      state: 'protocol_failure',
      acknowledgedEventId: 'd'.repeat(64),
    });
  });
});

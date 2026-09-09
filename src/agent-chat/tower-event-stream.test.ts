import { expect, test } from "bun:test";
import { consumeTowerEventStream } from "./tower-event-stream";

test("delivers sequentially before yielding to recovery and ignores connected cursor hints", async () => {
  const order: string[] = [];
  const encoded = new TextEncoder().encode('event: connected\ndata: {"cursor":"uncommitted"}\n\nevent: flightdeck_pg.event\ndata: {"event_id":"one"}\n\nevent: flightdeck_pg.event\ndata: {"event_id":"two"}\n\n');
  try {
    await consumeTowerEventStream({ signal: new AbortController().signal, isCurrent: () => true,
      connect: async () => new Response(encoded), deliver: async (event) => {
        order.push(`start:${event.event_id}`); await Bun.sleep(1); order.push(`end:${event.event_id}`);
      } });
  } catch { order.push("poll-recovery"); }
  expect(order).toEqual(["start:one", "end:one", "start:two", "end:two", "poll-recovery"]);
});

test("obsolete connection response cannot deliver stale events", async () => {
  let current = true;
  let deliveries = 0;
  await consumeTowerEventStream({ signal: new AbortController().signal, isCurrent: () => current,
    connect: async () => { current = false; return new Response('event: flightdeck_pg.event\ndata: {"event_id":"old"}\n\n'); },
    deliver: async () => { deliveries++; } });
  expect(deliveries).toBe(0);
});

test("application error closes and unlocks a stream before recovery", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("event: flightdeck_pg.error\ndata: {}\n\n")); },
    cancel() { cancelled = true; },
  });
  await expect(consumeTowerEventStream({ signal: new AbortController().signal, isCurrent: () => true,
    connect: async () => new Response(stream), deliver: async () => {},
  })).rejects.toThrow("event stream error");
  expect(cancelled).toBe(true);
  expect(stream.locked).toBe(false);
});

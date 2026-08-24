import { afterEach, describe, expect, test } from "bun:test";

import { startSessionSubscriber, stopSessionSubscriber } from "./subscriber.js";

class FakeEventSource {
  constructor() {
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.readyState = FakeEventSource.CONNECTING;
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
}

FakeEventSource.instances = [];
FakeEventSource.CONNECTING = 0;
FakeEventSource.OPEN = 1;
FakeEventSource.CLOSED = 2;

describe("session subscriber", () => {
  const originalEventSource = globalThis.EventSource;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const originalDateNow = Date.now;
  let intervalCallback = null;
  let currentTime = 0;

  afterEach(() => {
    stopSessionSubscriber();
    FakeEventSource.instances = [];
    globalThis.EventSource = originalEventSource;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    Date.now = originalDateNow;
    intervalCallback = null;
    currentTime = 0;
  });

  test("calls onConnect when the SSE stream opens", () => {
    let connected = 0;
    globalThis.EventSource = FakeEventSource;

    startSessionSubscriber({
      onConnect: () => {
        connected += 1;
      },
    });

    const source = FakeEventSource.instances[0];
    expect(source).toBeDefined();
    source.readyState = FakeEventSource.OPEN;
    source.onopen?.();

    expect(connected).toBe(1);
  });

  test("forwards parsed session lifecycle events", () => {
    const events = [];
    globalThis.EventSource = FakeEventSource;

    startSessionSubscriber({
      onEvent: (event) => {
        events.push(event);
      },
    });

    const source = FakeEventSource.instances[0];
    source.onmessage?.({
      data: JSON.stringify({ type: "session-started", sessionId: "session-1" }),
    });

    expect(events).toEqual([{ type: "session-started", sessionId: "session-1" }]);
  });

  test("requests a throttled refresh on the subscriber backstop interval", () => {
    const events = [];
    globalThis.EventSource = FakeEventSource;
    globalThis.setInterval = (callback) => {
      intervalCallback = callback;
      return 1;
    };
    globalThis.clearInterval = () => {};
    Date.now = () => currentTime;

    startSessionSubscriber({
      onEvent: (event) => {
        events.push(event);
      },
    });

    const source = FakeEventSource.instances[0];
    source.readyState = FakeEventSource.OPEN;
    source.onopen?.();

    currentTime = 15_000;
    intervalCallback?.();

    expect(events).toEqual([{ type: "session-refresh", reason: "backstop-interval" }]);
  });
});

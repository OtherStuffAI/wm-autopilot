import { afterEach, describe, expect, test } from "bun:test";

import { fetchAgentMessages, matchesReadyAgentType, waitForAgentReady } from "./agent-client";

describe("matchesReadyAgentType", () => {
  test("accepts exact agent type matches", () => {
    expect(matchesReadyAgentType("codex", "codex")).toBe(true);
    expect(matchesReadyAgentType("pi", "pi")).toBe(true);
  });

  test("accepts agentapi custom status for pi", () => {
    expect(matchesReadyAgentType("pi", "custom")).toBe(true);
  });

  test("rejects custom status for non-pi agents", () => {
    expect(matchesReadyAgentType("codex", "custom")).toBe(false);
    expect(matchesReadyAgentType("claude", "custom")).toBe(false);
  });
});

describe("waitForAgentReady", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("treats pi sessions reporting custom as ready", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          status: "stable",
          agent_type: "custom",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );

    await expect(
      waitForAgentReady("127.0.0.1", 3700, "pi", {
        timeoutMs: 100,
        pollIntervalMs: 10,
      }),
    ).resolves.toBeUndefined();
  });

  test("still times out when a non-pi custom session never matches", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          status: "stable",
          agent_type: "custom",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );

    await expect(
      waitForAgentReady("127.0.0.1", 3700, "codex", {
        timeoutMs: 30,
        pollIntervalMs: 10,
      }),
    ).rejects.toThrow("Timed out waiting for codex agent to become ready");
  });
});

describe("fetchAgentMessages", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("bounds a stalled messages request", async () => {
    globalThis.fetch = ((_url: URL | RequestInfo, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    })) as typeof fetch;

    await expect(fetchAgentMessages("127.0.0.1", 3700, { timeoutMs: 20 }))
      .rejects.toThrow("Agent messages request timed out after 20ms");
  });
});

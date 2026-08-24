import { describe, expect, test } from "bun:test";
import { LiveSessionMessageSync } from "./live-session-message-sync";

function createHarness(fetchMessages: () => Promise<any[]>) {
  const messages: any[] = [];
  const session = {
    id: "session-1",
    agent: "goose",
    status: "running",
    port: 3700,
    metadata: {},
  };
  return {
    messages,
    sync: new LiveSessionMessageSync({
      manager: {
        getSession: () => session,
        getAdapter: () => ({ fetchMessages }),
      } as never,
      messageStore: {
        hasMessages: () => messages.length > 0,
        listSessionMessages: () => messages.map((message) => ({ ...message })),
        replaceMessages: (_sessionId: string, next: any[]) => {
          messages.splice(0, messages.length, ...next.map((message, index) => ({
            id: `message-${index}`,
            sessionId: session.id,
            ...message,
          })));
        },
      } as never,
      agentHost: "127.0.0.1",
      minimumRefreshIntervalMs: 0,
    }),
  };
}

describe("LiveSessionMessageSync", () => {
  test("coalesces overlapping sync requests for one session", async () => {
    let fetchCount = 0;
    let release: ((messages: any[]) => void) | null = null;
    const harness = createHarness(() => {
      fetchCount += 1;
      return new Promise((resolve) => { release = resolve; });
    });

    const first = harness.sync.sync("session-1", true);
    const second = harness.sync.sync("session-1", true);
    expect(fetchCount).toBe(1);
    release?.([{ role: "assistant", content: "done", createdAt: "2026-08-24T09:00:00Z" }]);

    expect(await first).toEqual(await second);
    expect(fetchCount).toBe(1);
  });

  test("clears single-flight state after failure so the next sync catches up", async () => {
    let fetchCount = 0;
    const harness = createHarness(async () => {
      fetchCount += 1;
      if (fetchCount === 1) throw new Error("messages request timed out");
      return [{ role: "assistant", content: "recovered", createdAt: "2026-08-24T09:00:01Z" }];
    });

    expect(await harness.sync.sync("session-1", true)).toEqual([]);
    expect(await harness.sync.sync("session-1", true)).toHaveLength(1);
    expect(fetchCount).toBe(2);
  });
});

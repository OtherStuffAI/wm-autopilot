import { describe, expect, test } from "bun:test";
import { sessionMessageResponse } from "./session-message-response";

describe("session message response", () => {
  test("saved history responds while fresh upstream is indefinitely delayed", async () => {
    const saved = [{ role: "user", content: "durable", createdAt: "2026-10-08T00:00:00Z" }];
    let syncCalls = 0;
    const context = {
      messageStore: { listSessionMessages: () => saved },
      syncSessionMessages: () => { syncCalls += 1; return new Promise<unknown[]>(() => {}); },
    };
    const response = await sessionMessageResponse("fixture", false, context);
    expect(await response.json()).toEqual({ id: "fixture", messages: saved });
    expect(syncCalls).toBe(0);
    expect(response.headers.get("server-timing")).toMatch(/^session-history;dur=[\d.]+;desc="saved"$/);
  });

  test("refresh failures are explicit and preserve the durable store", async () => {
    const saved = [{ content: "durable" }];
    const context = {
      messageStore: { listSessionMessages: () => saved },
      syncSessionMessages: async () => { throw new Error("upstream timed out"); },
    };
    const response = await sessionMessageResponse("fixture", true, context);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Session history refresh failed: upstream timed out" });
    expect(saved).toEqual([{ content: "durable" }]);
  });
});

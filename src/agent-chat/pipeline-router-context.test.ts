import { describe, expect, test } from "bun:test";
import { boundRouterContext } from "./pipeline-router-context.ts";
import type { PipelineRouterRequest } from "./pipeline-router-handler.ts";
import type { FlightDeckPgMessage } from "./tower-client.ts";

const request = { subscription: { workspaceId: "workspace" }, channelId: "channel", threadId: "thread",
  message: { id: "current", body: "Following, 100 please", sender_npub: "human" } } as PipelineRouterRequest;
function message(id: string, second: number, body = id, inherited = false): FlightDeckPgMessage {
  return { id, workspace_id: "workspace", channel_id: "channel", thread_id: inherited ? "parent" : "thread",
    effective_thread_id: "thread", inherited, body, sender_npub: "human", created_at: new Date(second * 1000).toISOString() };
}
const current = message("current", 100, request.message.body!);
describe("bounded authoritative router history", () => {
  test("orders inherited and local context, excludes the source and later dispatch messages", () => {
    const context = boundRouterContext([message("later", 110), current, message("clarification", 90), message("inherited", 80, "Summarize tweets", true)], request);
    expect(context.messages).toEqual([
      { id: "inherited", body: "Summarize tweets", senderNpub: "human", createdAt: message("inherited", 80).created_at, inherited: true, bodyTruncated: false },
      { id: "clarification", body: "clarification", senderNpub: "human", createdAt: message("clarification", 90).created_at, inherited: false, bodyTruncated: false },
    ]);
    expect(context).toMatchObject({ truncated: false, excludedLaterMessages: 1, omittedMessages: 0 });
  });
  test("bounds message count and characters and reports omitted/clipped context", () => {
    const context = boundRouterContext([...Array.from({ length: 60 }, (_, i) => message(String(i), i, "x".repeat(3000))), current], request);
    expect((context.messages as unknown[]).length).toBe(8);
    expect(context).toMatchObject({ truncated: true, omittedMessages: 52, clippedMessages: 8 });
    expect(JSON.stringify(context).length).toBeLessThan(19000);
  });
  test("fails closed on missing, inherited or changed source and cross-route data", () => {
    expect(() => boundRouterContext([], request)).toThrow("absent");
    expect(() => boundRouterContext([{ ...current, inherited: true }], request)).toThrow("absent");
    expect(() => boundRouterContext([{ ...current, body: "changed" }], request)).toThrow("changed");
    for (const field of ["workspace_id", "channel_id", "effective_thread_id"]) {
      expect(() => boundRouterContext([{ ...current, [field]: "other" }], request)).toThrow("authorized route");
    }
    expect(() => boundRouterContext([{ ...current, created_at: "invalid" }], request)).toThrow("chronology");
  });
  test("orders equal timestamps by ID and respects timezone offsets", () => {
    const before = { ...message("before", 90), created_at: "1970-01-01T01:01:30+01:00" };
    const equalBefore = message("a", 100);
    const equalAfter = message("z", 100);
    const context = boundRouterContext([equalAfter, current, equalBefore, before], request);
    expect((context.messages as any[]).map(message => message.id)).toEqual(["before", "a"]);
    expect(context.excludedLaterMessages).toBe(1);
    expect(() => boundRouterContext([current, current], request)).toThrow("repeats");
  });
  test("never clips the current actionable question", () => {
    const body = "x".repeat(8001);
    expect(() => boundRouterContext([{ ...current, body }], { ...request, message: { ...request.message, body } })).toThrow("exceeds");
  });
});

test("router recovers signed effective pages with inherited context and surfaces a later-page error", async () => {
  const { readRouterContext } = await import("./pipeline-router-context.ts");
  const { createBotIdentityFromSecret } = await import("../flightdeck-pg/client.ts");
  const nativeFetch = globalThis.fetch;
  const routed = { ...request, botIdentity: createBotIdentityFromSecret(new Uint8Array(32).fill(1)),
    subscription: { ...request.subscription, backendBaseUrl: "http://tower.test", sourceAppNpub: "npub-app" } } as PipelineRouterRequest;
  const calls: { url: URL; authorization: string | null }[] = [];
  let fail = false;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    calls.push({ url: parsed, authorization: new Headers(init?.headers).get("authorization") });
    if (parsed.searchParams.has("cursor")) {
      if (fail) return Response.json({ error: "denied" }, { status: 403 });
      return Response.json({ effective_transcript: true, messages: [current, message("later", 110)], next_cursor: null });
    }
    return Response.json({ effective_transcript: true, messages: [message("parent", 90, "Summarize tweets", true)], next_cursor: "page-2" });
  }) as typeof fetch;
  try {
    const context = await readRouterContext(routed);
    expect(context).toMatchObject({ messages: [{ id: "parent", inherited: true }], excludedLaterMessages: 1 });
    expect(calls).toHaveLength(2);
    expect(calls.every(call => call.url.searchParams.get("effective_transcript") === "true" && call.authorization?.startsWith("Nostr "))).toBe(true);
    expect(calls[1]!.url.searchParams.get("cursor")).toBe("page-2");
    fail = true;
    await expect(readRouterContext(routed)).rejects.toThrow();
  } finally { globalThis.fetch = nativeFetch; }
});

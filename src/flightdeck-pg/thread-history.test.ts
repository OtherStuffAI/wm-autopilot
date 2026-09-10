import { afterEach, describe, expect, test } from "bun:test";

import { createBotIdentityFromSecret } from "./client.ts";
import { readFlightDeckHistory } from "./thread-history.ts";
import { historyMessages, historyPage } from "./__tests__/history-fixture.ts";

const originalFetch = globalThis.fetch;
const input = {
  backendBaseUrl: "http://tower.test",
  workspaceId: "workspace-1",
  channelId: "channel-1",
  threadId: "thread-1",
  appNpub: "npub-app",
  botIdentity: createBotIdentityFromSecret(new Uint8Array(32).fill(1)),
};

afterEach(() => { globalThis.fetch = originalFetch; });

function servePages(pages: unknown[]) {
  let calls = 0;
  globalThis.fetch = (async () => {
    const page = pages[calls++];
    if (page === undefined) throw new Error("Unexpected extra history request");
    return page instanceof Response ? page : Response.json(page);
  }) as typeof fetch;
  return () => calls;
}

const emptyPage = { effective_transcript: true, messages: [], next_cursor: null };

describe("manual effective history recovery", () => {
  for (const limit of [undefined, 73, 500]) {
    test(`retains later and inherited images with page size ${limit ?? "default"}`, async () => {
      const requests: URL[] = [];
      globalThis.fetch = (async (url: string | URL | Request) => {
        const parsed = new URL(url instanceof Request ? url.url : url);
        requests.push(parsed);
        return Response.json(historyPage(parsed));
      }) as typeof fetch;
      const result = await readFlightDeckHistory({ ...input, limit });
      expect(result.messages).toEqual(historyMessages);
      expect(result).toMatchObject({ complete: true, effective_transcript: true, next_cursor: null });
      expect(result.pages_read).toBe(Math.ceil(205 / (limit ?? 200)));
      expect(requests.every((url) => url.searchParams.get("effective_transcript") === "true")).toBe(true);
      expect(requests[0]!.searchParams.has("cursor")).toBe(false);
    });
  }

  test("empty transcript is complete only at an explicit terminal cursor", async () => {
    const calls = servePages([emptyPage]);
    expect(await readFlightDeckHistory(input)).toMatchObject({ messages: [], complete: true, pages_read: 1 });
    expect(calls()).toBe(1);
  });

  test("follows an empty nonterminal page and an opaque cursor", async () => {
    const cursor = "opaque/+ =?&";
    const requests: URL[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      const parsed = new URL(url instanceof Request ? url.url : url);
      requests.push(parsed);
      return Response.json(requests.length === 1
        ? { ...emptyPage, next_cursor: cursor }
        : { ...emptyPage, messages: [historyMessages[204]] });
    }) as typeof fetch;
    expect((await readFlightDeckHistory(input)).messages).toEqual([historyMessages[204]!]);
    expect(requests[1]!.searchParams.get("cursor")).toBe(cursor);
  });

  for (const cursors of [["a", "a"], ["a", "b", "a"]]) {
    test(`rejects cursor cycle ${cursors.join(" -> ")}`, async () => {
      const calls = servePages(cursors.map((next_cursor) => ({ ...emptyPage, next_cursor })));
      await expect(readFlightDeckHistory(input)).rejects.toThrow("repeated a history cursor");
      expect(calls()).toBe(cursors.length);
    });
  }

  for (const invalid of [
    { messages: [], next_cursor: null },
    { ...emptyPage, effective_transcript: false },
    { ...emptyPage, messages: null },
    { effective_transcript: true, messages: [] },
    { ...emptyPage, next_cursor: "" },
    { ...emptyPage, next_cursor: 123 },
    null,
  ]) {
    test(`rejects unconfirmed or malformed history ${JSON.stringify(invalid)}`, async () => {
      servePages([invalid]);
      await expect(readFlightDeckHistory(input)).rejects.toThrow();
    });
  }

  test("rejects changed cursor semantics", async () => {
    servePages([{ ...emptyPage, next_cursor: "a", cursor_semantics: { version: 1 } },
      { ...emptyPage, cursor_semantics: { version: 2 } }]);
    await expect(readFlightDeckHistory(input)).rejects.toThrow("semantics changed");
  });

  for (const failOnFirstPage of [true, false]) {
    test(`propagates ${failOnFirstPage ? "initial" : "later"} page failure without partial success`, async () => {
      const failure = Response.json({ error: "Tower unavailable" }, { status: 503 });
      servePages(failOnFirstPage ? [failure] : [{ ...emptyPage, next_cursor: "a" }, failure]);
      await expect(readFlightDeckHistory(input)).rejects.toThrow();
    });
  }

  test("channel-only recovery retains non-effective status", async () => {
    servePages([{ ...emptyPage, effective_transcript: false }]);
    expect(await readFlightDeckHistory({ ...input, threadId: null })).toMatchObject({
      complete: true, effective_transcript: false,
    });
  });

  for (const limit of [0, -1, 501, 1.5, NaN, Infinity]) {
    test(`rejects invalid page size ${limit} before fetching`, async () => {
      const calls = servePages([]);
      await expect(readFlightDeckHistory({ ...input, limit })).rejects.toThrow("page size");
      expect(calls()).toBe(0);
    });
  }
});

import { describe, expect, test } from "bun:test";
import { createSessionHistoryLoader } from "./session-history-loader.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const pending = [];
  const writes = [];
  let revision = 0;
  const loader = createSessionHistoryLoader({
    fetchMessages: (id, options) => {
      const request = deferred(); pending.push({ id, ...options, ...request }); return request.promise;
    },
    store: {
      getRevision: async () => revision,
      syncFromServerIfChanged: async (id, messages, options) => {
        if (options.signal.aborted || options.expectedRevision !== revision) return { stale: true, changed: false };
        writes.push({ id, messages }); revision += 1; return { changed: true };
      },
    },
  });
  return { loader, pending, writes, streamWrite: () => { revision += 1; } };
}
const tick = () => Promise.resolve();

describe("session history request coordination", () => {
  test("coalesces redundant bootstrap reads", async () => {
    const f = fixture(); const first = f.loader.sync("a"); const second = f.loader.sync("a");
    await tick(); expect(f.pending).toHaveLength(1);
    f.pending[0].resolve({ messages: [{ content: "saved" }] });
    expect(await first).toEqual(await second); expect(f.writes).toHaveLength(1);
  });
  test("late old refresh cannot overwrite a newer saved response", async () => {
    const f = fixture(); const old = f.loader.sync("a", { refresh: true }); await tick();
    const newer = f.loader.sync("a"); await tick();
    f.pending[1].resolve({ messages: [{ content: "newer" }] }); await newer;
    f.pending[0].resolve({ messages: [{ content: "old" }] });
    expect(await old).toEqual({ stale: true, changed: false });
    expect(f.writes).toEqual([{ id: "a", messages: [{ content: "newer" }] }]);
  });
  test("SSE writes invalidate a snapshot captured before the stream advanced", async () => {
    const f = fixture(); const request = f.loader.sync("a"); await tick(); f.streamWrite();
    f.pending[0].resolve({ messages: [] }); expect((await request).stale).toBe(true); expect(f.writes).toEqual([]);
  });
  test("A to B to A switch cancels the old A request even when fetch ignores abort", async () => {
    const f = fixture(); const old = f.loader.sync("a"); await tick(); f.loader.cancel("a");
    const b = f.loader.sync("b"); await tick(); f.loader.cancel("b");
    const next = f.loader.sync("a"); await tick();
    f.pending[2].resolve({ messages: [{ content: "current A" }] }); await next;
    f.pending[0].resolve({ messages: [{ content: "old A" }] }); f.pending[1].resolve({ messages: [{ content: "B" }] });
    await Promise.all([old, b]); expect(f.pending[0].signal.aborted).toBe(true);
    expect(f.writes).toEqual([{ id: "a", messages: [{ content: "current A" }] }]);
  });
  test("errors surface and allow retry; successful empty history is accepted", async () => {
    const f = fixture(); const failed = f.loader.sync("a", { refresh: true }); await tick();
    f.pending[0].resolve(null); await expect(failed).rejects.toThrow("Could not refresh current messages");
    const retry = f.loader.sync("a", { refresh: true }); await tick(); f.pending[1].resolve({ messages: [] });
    expect(await retry).toEqual({ changed: true }); expect(f.writes).toEqual([{ id: "a", messages: [] }]);
  });
});

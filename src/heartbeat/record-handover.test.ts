import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { fixture, change, pagePayload } from "./record-sync-fixture.test-helper.ts";

const target = "9007199254740993";
function delta(nextTarget: string, access = "2", through = target, complete = false) {
  return pagePayload([change(`row-${nextTarget}`, "message")], true, {
    has_more: !complete,
    access_revision: access,
    handover: { target_position: nextTarget, through_position: through, complete,
      authority_epoch: "epoch", access_revision: access },
  });
}

test("saved unfinished target resumes across reopen after authority gain without replacing identity", async () => {
  const extended = "9007199254740995";
  const f = fixture([pagePayload([change("retained")]), delta(extended), delta(extended, "2", extended, true)]);
  try {
    const before = await f.run({ maxPages: 1 });
    expect(before.coverage.handoverTarget).toBe(target);
    expect(before.syncComplete).toBe(false);
    const after = await f.run();
    expect(after.cache.clientId).toBe(before.cache.clientId);
    expect(after.cache.generation).toBe(before.cache.generation);
    expect(after.syncComplete).toBe(true);
    expect(after.coverage.handoverTarget).toBe(extended);
    expect(after.coverage.downloadedCounts.task).toBe(1);
    expect(after.cache.pendingAck).toBe(false);
    const pages = f.calls.filter(c => c.url.pathname.endsWith("/record-sync"));
    expect(pages[1]!.url.searchParams.get("cursor")).toBe("opaque-1");
  } finally { rmSync(f.cacheRoot, { recursive: true, force: true }); }
});

for (const [label, payload, error] of [
  ["content-only growth", delta("9007199254740995", "1"), "Fixed handover target changed"],
  ["authority target regression", delta("9007199254740992", "2", "0"), "Handover target regressed"],
  ["authority position regression", delta("9007199254740995", "2", "0"), "Handover position regressed"],
  ["authority through beyond target", delta("9007199254740995", "2", "9007199254740996"), "exceeds target"],
] as const) {
  test(`${label} rejects atomically without acknowledgement`, async () => {
    const first = delta(target, "1", "1");
    const f = fixture([pagePayload([change("retained")]), first, payload]);
    try {
      const before = await f.run({ maxPages: 2 });
      const ackCount = f.calls.filter(c => c.url.pathname.endsWith("/ack")).length;
      const after = await f.run();
      expect(after.errors.some(e => e.includes(error))).toBe(true);
      expect(after.syncComplete).toBe(false);
      expect(after.coverage.handoverTarget).toBe(before.coverage.handoverTarget);
      expect(after.coverage.handoverThrough).toBe(before.coverage.handoverThrough);
      expect(after.coverage.downloadedCounts).toEqual(before.coverage.downloadedCounts);
      expect(f.calls.filter(c => c.url.pathname.endsWith("/ack")).length).toBe(ackCount);
    } finally { rmSync(f.cacheRoot, { recursive: true, force: true }); }
  });
}

test("a certified round can start a new content boundary without authority change", async () => {
  const extended = "9007199254740995";
  const f = fixture([pagePayload(), pagePayload([], true), delta(extended, "1", extended, true)]);
  try {
    expect((await f.run()).syncComplete).toBe(true);
    const next = await f.run();
    expect(next.syncComplete).toBe(true);
    expect(next.coverage.handoverTarget).toBe(extended);
  } finally { rmSync(f.cacheRoot, { recursive: true, force: true }); }
});

import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { RecordSyncCache } from "./record-sync-cache.ts";
import { readCacheReview } from "./record-cache-review.ts";
import { change, families, fixture, pagePayload } from "./record-sync-fixture.test-helper.ts";

const expanded = [...families, "personal_pin"];

test("bounded additive delta retains rows and acknowledgements without inventing bootstrap coverage", async () => {
  const f = fixture([
    pagePayload([change("saved", "task", "1", { state: "in_progress" })]),
    pagePayload([], true),
    pagePayload([change("pin", "personal_pin", "2")], true, { families: expanded }),
    pagePayload([], true, { families: expanded }),
  ]);
  try {
    const before = await f.run();
    const after = await f.run();
    expect(after.cache.clientId).toBe(before.cache.clientId);
    expect(after.cache.generation).toBe(before.cache.generation);
    expect(after.cache.pendingAck).toBe(false);
    expect(after.coverage.downloadedCounts).toMatchObject({ task: 1, personal_pin: 1 });
    expect(after.coverage.advertisedFamilies).toEqual(expanded);
    expect(after.coverage.completedFamilies).toEqual(families);
    expect(after.coverage.unfinishedFamilies).toEqual(["personal_pin"]);
    expect(after.coverage.deltaHandoverObserved).toBe(true);
    expect(after.coverage.unavailablePartitions).toBe(0);
    expect(after.syncComplete).toBe(false);
    expect(after.complete).toBe(false);
    expect(after.errors).toEqual(["Snapshot coverage unavailable for advertised families: personal_pin"]);
    const pinned = await f.run({ reviewOnly: true });
    expect(pinned.errors).toEqual(after.errors);
    expect(pinned.syncComplete).toBe(false);
    const reopened = await f.run({ syncOnly: true });
    expect(reopened.errors).toEqual(after.errors);
    expect(reopened.review.started).toBe(false);
    expect(reopened.coverage.unfinishedFamilies).toEqual(["personal_pin"]);
    const cache = new RecordSyncCache(after.cache.path, ["https://tower.test", "workspace", "app", "viewer"]);
    try {
      expect(cache.state().revision).toBe("4");
      expect(cache.state().cursor).toBe("opaque-4");
      expect(cache.pending()).toBeNull();
    } finally { cache.close(); }
  } finally { rmSync(f.cacheRoot, { recursive: true, force: true }); }
});

test("removal cannot advance rows, checkpoint or ack", async () => {
  const f = fixture([pagePayload([change("saved")]), pagePayload([], true),
    pagePayload([change("unexpected")], true, { families: families.filter(v => v !== "message") })]);
  try {
    const before = await f.run();
    const after = await f.run();
    expect(after.errors.join(" ")).toContain("Advertised families removed: message");
    expect(after.coverage.pages).toBe(0);
    expect(after.coverage.downloadedCounts.task).toBe(1);
    expect(after.cache).toEqual(before.cache);
    expect(f.calls.filter(c => c.url.pathname.endsWith("/ack"))).toHaveLength(2);
  } finally { rmSync(f.cacheRoot, { recursive: true, force: true }); }
});

test("family addition during incomplete snapshot cannot skip earlier keyset families", async () => {
  const f = fixture([
    pagePayload([change("saved")], false, { snapshot_complete: false, partitions_complete: [] }),
    pagePayload([change("missed", "personal_pin")], false, { families: expanded, partitions_complete: expanded }),
  ]);
  try {
    const r = await f.run();
    expect(r.errors.join(" ")).toContain("outside bounded delta");
    expect(r.coverage.snapshotComplete).toBe(false);
    expect(r.coverage.pages).toBe(1);
    expect(r.coverage.downloadedCounts.personal_pin).toBeUndefined();
    expect(r.cache.pendingAck).toBe(false);
  } finally { rmSync(f.cacheRoot, { recursive: true, force: true }); }
});

test("unextended delta additions remain blocked", async () => {
  const f = fixture([pagePayload(), pagePayload([], true), pagePayload([], true, { families: expanded })]);
  f.setExtension(false);
  try {
    await f.run();
    const r = await f.run();
    expect(r.errors.join(" ")).toContain("outside bounded delta");
    expect(r.coverage.advertisedFamilies).toEqual(families);
  } finally { rmSync(f.cacheRoot, { recursive: true, force: true }); }
});

test("fresh snapshot includes new family and can certify; advertisement order is irrelevant", async () => {
  const f = fixture([pagePayload([change("pin", "personal_pin")], false, { families: expanded, partitions_complete: expanded }),
    pagePayload([], true, { families: [...expanded].reverse() })]);
  try {
    const r = await f.run();
    expect(r.syncComplete).toBe(true);
    expect(r.coverage.unfinishedFamilies).toEqual([]);
    expect(r.coverage.downloadedCounts.personal_pin).toBe(1);
  } finally { rmSync(f.cacheRoot, { recursive: true, force: true }); }
});

test("additive compatibility does not weaken authority fencing or expose revoked rows", async () => {
  const f = fixture([pagePayload([change("saved", "task", "1", { state: "in_progress" })]), pagePayload([], true),
    pagePayload([change("pin", "personal_pin", "2")], true, { families: expanded, access_changes: [
      { family: "task", resource_type: "channel", resource_id: "channel", status: "lost" },
    ] })]);
  try {
    await f.run();
    const r = await f.run();
    expect(r.coverage.unavailablePartitions).toBe(1);
    expect(r.workspaces[0]!.review.some(row => row.id === "saved")).toBe(false);
    expect(r.errors.join(" ")).toContain("unavailable authority partitions");
    expect(r.coverage.unfinishedFamilies).toEqual(["personal_pin"]);
  } finally { rmSync(f.cacheRoot, { recursive: true, force: true }); }
});

test("review continuation fences family coverage even at an otherwise identical checkpoint", async () => {
  const f = fixture([pagePayload([change("a", "task", "1", { state: "review" }), change("b", "task", "1", { state: "review" })]), pagePayload([], true)]);
  try {
    const r = await f.run();
    const cache = new RecordSyncCache(r.cache.path, ["https://tower.test", "workspace", "app", "viewer"]);
    try {
      const state = cache.state();
      const review = readCacheReview(cache.db, state, "2000-01-01T00:00:00Z", 262144, 1);
      expect(review.nextCursor).not.toBeNull();
      for (const changed of [{ ...state, families: expanded }, { ...state, partitions: state.partitions.slice(1) }])
        expect(() => readCacheReview(cache.db, changed, review.since, 262144, 1, review.nextCursor!)).toThrow("Review checkpoint changed");
    } finally { cache.close(); }
  } finally { rmSync(f.cacheRoot, { recursive: true, force: true }); }
});

for (const defect of ["authority", "target"] as const) {
  test(`additive page cannot bypass ${defect} consistency`, async () => {
    const f = fixture([pagePayload(), pagePayload([], true),
      pagePayload([change("pin", "personal_pin")], false, {
        families: expanded,
        mode: "delta", snapshot_id: null, snapshot_complete: false,
        partitions_complete: [], access_revision: defect === "authority" ? "0" : "1",
        handover: { target_position: "9007199254740994", through_position: "9007199254740993",
          complete: false, authority_epoch: "epoch", access_revision: defect === "authority" ? "0" : "1" },
      }),
      pagePayload([change("pin2", "personal_pin")], true, {
        families: expanded,
        handover: { target_position: "9007199254740995", through_position: "9007199254740995",
          complete: true, authority_epoch: "epoch", access_revision: "1" },
      }),
    ]);
    try {
      const before = await f.run();
      const after = await f.run();
      expect(after.errors.join(" ")).toContain(defect === "authority" ? "Stale authority response" : "Fixed handover target changed");
      expect(after.cache.pendingAck).toBe(false);
      expect(after.cache.clientId).toBe(before.cache.clientId);
      expect(after.coverage.downloadedCounts.personal_pin).toBe(defect === "authority" ? undefined : 1);
      const cache = new RecordSyncCache(after.cache.path, ["https://tower.test", "workspace", "app", "viewer"]);
      try {
        expect(cache.state().cursor).toBe(defect === "authority" ? "opaque-2" : "opaque-3");
        expect(cache.state().revision).toBe(defect === "authority" ? "2" : "3");
      } finally { cache.close(); }
    } finally { rmSync(f.cacheRoot, { recursive: true, force: true }); }
  });
}

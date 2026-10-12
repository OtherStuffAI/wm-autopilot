import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { runHeartbeatCatchUp } from "./heartbeat-catch-up.ts";
import {
  change,
  fixture,
  pagePayload,
} from "./record-sync-fixture.test-helper.ts";

test("catch-up resumes existing ID over bounded wakes and stops on certification independently of >200 summaries", async () => {
  const now = new Date().toISOString();
  const f = fixture([
    pagePayload(
      Array.from({ length: 200 }, (_, i) =>
        change(String(i), "task", "1", { state: "ready", updated_at: now }),
      ),
      false,
      { snapshot_complete: false },
    ),
    pagePayload(
      Array.from({ length: 200 }, (_, i) =>
        change(String(i + 200), "message", "1", { updated_at: now }),
      ),
    ),
    pagePayload([], true),
  ]);
  try {
    const existing = await f.run({ maxPages: 1, syncOnly: true });
    const ids: string[] = [];
    const result = await runHeartbeatCatchUp(
      { hours: 12, maxPages: 1 },
      10,
      (r) => {
        ids.push(r.cache.clientId);
      },
      f.run,
    );
    expect(result.outcome).toBe("certified");
    expect(result.wakes).toBe(2);
    expect(ids).toEqual([existing.cache.clientId, existing.cache.clientId]);
    expect(result.result.syncComplete).toBe(true);
    expect(result.result.complete).toBe(false);
    expect(result.result.review.started).toBe(false);
    expect(result.result.workspaces[0]!.review).toEqual([]);
    const reviewed = await f.run({ reviewOnly: true });
    expect(reviewed.syncComplete).toBe(true);
    expect(reviewed.coverage.reviewTruncated).toBe(true);
  } finally {
    rmSync(f.cacheRoot, { recursive: true, force: true });
  }
});

test("catch-up stops on real errors, uncertifiable protocol and explicit wake cap", async () => {
  const f = fixture([pagePayload([change("a")]), pagePayload([], true)]);
  try {
    let result = await runHeartbeatCatchUp(
      { hours: 12, maxPages: 1 },
      1,
      undefined,
      f.run,
    );
    expect(result.outcome).toBe("wake_limit");
    f.setPageError("access_revoked");
    result = await runHeartbeatCatchUp({ hours: 12 }, 10, undefined, f.run);
    expect(result.outcome).toBe("blocked");
    expect(result.wakes).toBe(1);
    f.setPageError(null);
    f.setExtension(false);
    result = await runHeartbeatCatchUp({ hours: 12 }, 10, undefined, f.run);
    expect(result.outcome).toBe("blocked");
    expect(result.result.errors.join()).toContain("not negotiated");
    await expect(
      runHeartbeatCatchUp({ hours: 12 }, 0, undefined, f.run),
    ).rejects.toThrow("positive");
    await expect(
      runHeartbeatCatchUp({ hours: 12, reviewOnly: true }, 1, undefined, f.run),
    ).rejects.toThrow("continuation");
  } finally {
    rmSync(f.cacheRoot, { recursive: true, force: true });
  }
});

test("catch-up does not spin on budget deferral without page progress", async () => {
  const f = fixture([]);
  try {
    const result = await runHeartbeatCatchUp(
      { hours: 12, maxTimeMs: 30000 },
      100,
      undefined,
      f.run,
    );
    expect(result.outcome).toBe("blocked");
    expect(result.wakes).toBe(1);
    expect(result.result.coverage.pages).toBe(0);
  } finally {
    rmSync(f.cacheRoot, { recursive: true, force: true });
  }
});

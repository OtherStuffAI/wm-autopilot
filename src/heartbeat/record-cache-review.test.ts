import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Database } from "bun:sqlite";
import { RecordSyncCache } from "./record-sync-cache.ts";
import {
  change,
  fixture,
  pagePayload,
} from "./record-sync-fixture.test-helper.ts";
import { readCacheReview } from "./record-cache-review.ts";

function reviewFixture(old = 230, recent = 300) {
  const now = new Date().toISOString();
  const changes = [
    ...Array.from({ length: old }, (_, i) =>
      change(`old-${i}`, "task", "1", { state: "in_progress" }),
    ),
    ...Array.from({ length: 100 }, (_, i) =>
      change(`recent-task-${i}`, "task", "1", {
        state: "review",
        updated_at: now,
      }),
    ),
    ...Array.from({ length: 20 }, (_, i) =>
      change(`closed-${i}`, "task", "1", { state: "done", updated_at: now }),
    ),
    ...Array.from({ length: recent }, (_, i) =>
      change(`comment-${i}`, "task_comment", "1", {
        body: "activity",
        updated_at: now,
      }),
    ),
    change("old-closed", "task", "1", { state: "done" }),
  ];
  const pages = [];
  for (let i = 0; i < changes.length; i += 200)
    pages.push(
      pagePayload(changes.slice(i, i + 200), false, {
        snapshot_complete: i + 200 >= changes.length,
      }),
    );
  pages.push(pagePayload([], true));
  pages.push(
    pagePayload(
      [
        change("old-0", "task", "2", { state: "done" }),
        change("incremental", "message", "2", { updated_at: now }),
      ],
      true,
    ),
  );
  return fixture(pages);
}

test("all >200 active tasks and recent activity traverse pinned durable pages with replay and no sync", async () => {
  const f = reviewFixture();
  try {
    let r = await f.run();
    expect(r.syncComplete).toBe(true);
    expect(r.complete).toBe(false);
    expect(r.errors).toEqual([]);
    expect(r.review.total).toBe(650);
    const ids = r.workspaces[0]!.review.map((v) => `${v.family}/${v.id}`);
    const since = r.review.since;
    const calls = f.calls.length;
    const token = r.review.nextCursor!;
    const replayA = await f.run({ reviewOnly: true, reviewCursor: token });
    const replayB = await f.run({
      reviewOnly: true,
      reviewCursor: token,
      hours: 1,
    });
    expect(replayB.workspaces).toEqual(replayA.workspaces);
    expect(replayB.review).toEqual(replayA.review);
    expect(replayB.recentTriageHours).toBeNull();
    while (r.review.nextCursor) {
      r = await f.run({
        reviewOnly: true,
        reviewCursor: r.review.nextCursor,
        hours: 1,
      });
      expect(r.review.since).toBe(since);
      expect(r.workspaces[0]!.review.length).toBeLessThanOrEqual(200);
      expect(
        Buffer.byteLength(JSON.stringify(r.workspaces[0]!.review)),
      ).toBeLessThanOrEqual(262144);
      ids.push(...r.workspaces[0]!.review.map((v) => `${v.family}/${v.id}`));
    }
    expect(f.calls.length).toBe(calls);
    expect(ids.length).toBe(650);
    expect(new Set(ids).size).toBe(650);
    expect(r.review.delivered).toBe(650);
    expect(r.complete).toBe(true);
    expect(ids).not.toContain("task/old-closed");
    // Each run reopens the SQLite cache. Second sync wake resumes the existing cursor.
    const next = await f.run();
    expect(next.coverage.pages).toBe(1);
    expect(next.cache.clientId).toBe(r.cache.clientId);
    expect(next.coverage.downloadedCounts.message).toBe(1);
    expect(next.workspaces[0]!.review.some((v) => v.id === "old-0")).toBe(
      false,
    );
    expect(next.review.total).toBe(650);
    expect(
      f.calls
        .filter((c) => c.url.pathname.endsWith("record-sync"))
        .at(-1)
        ?.url.searchParams.get("cursor"),
    ).toBe("opaque-5");
    await expect(
      f.run({ reviewOnly: true, reviewCursor: token }),
    ).rejects.toThrow("missing");
  } finally {
    rmSync(f.cacheRoot, { recursive: true, force: true });
  }
});

test("exact phase/page boundaries, byte limits and invalid continuations", async () => {
  const f = reviewFixture(200, 0);
  try {
    const r = await f.run();
    const cache = new RecordSyncCache(r.cache.path, [
      "https://tower.test",
      "workspace",
      "app",
      "viewer",
    ]);
    try {
      const boundary = (
        cache.db.query("SELECT max(updated) AS stamp FROM rows").get() as {
          stamp: string;
        }
      ).stamp;
      const first = cache.review(boundary, 262144, 200);
      expect(first.rows.length).toBe(200);
      const next = cache.review("ignored", 262144, 200, first.nextCursor!);
      expect(next.rows.length).toBe(120);
      expect(next.nextCursor).toBeNull();
      expect(
        next.rows.every(
          (v) =>
            String(v.id).startsWith("recent-") ||
            String(v.id).startsWith("closed-"),
        ),
      ).toBe(true);
      const small = cache.review(r.since, 1000, 200);
      expect(small.rows.length).toBeGreaterThan(0);
      expect(small.truncated).toBe(true);
      let cursor = small.nextCursor;
      let count = small.rows.length;
      while (cursor) {
        const page = cache.review("ignored", 1000, 200, cursor);
        count += page.rows.length;
        cursor = page.nextCursor;
      }
      expect(count).toBe(320);
      expect(() => cache.review(r.since, 2)).toThrow("exceeds byte budget");
      expect(() => cache.review(r.since, 262145)).toThrow("bounds");
      expect(() => cache.review(r.since, 262144, 200, "tampered")).toThrow(
        "Invalid",
      );
      expect(() => cache.review(r.since, 262144, 200, "a".repeat(64))).toThrow(
        "missing",
      );
      const plan = cache.db
        .query(
          "EXPLAIN QUERY PLAN SELECT * FROM rows WHERE generation=? AND operation='upsert' AND updated>=? AND (updated,family,id)>(?,?,?) ORDER BY updated,family,id LIMIT 201",
        )
        .all(r.cache.generation, r.since, "", "", "");
      expect(JSON.stringify(plan)).toContain("review_rows");
      expect(JSON.stringify(plan)).not.toContain("TEMP B-TREE");
    } finally {
      cache.close();
    }
  } finally {
    rmSync(f.cacheRoot, { recursive: true, force: true });
  }
});

test("authority excludes workspace/channel/scope/resource families; changed checkpoint cannot continue", async () => {
  const f = reviewFixture();
  try {
    const r = await f.run();
    const cache = new RecordSyncCache(r.cache.path, [
      "https://tower.test",
      "workspace",
      "app",
      "viewer",
    ]);
    try {
      for (const kind of ["workspace", "channel", "scope"]) {
        cache.db
          .query("INSERT INTO access VALUES(?,?,?,?,?,?)")
          .run(
            r.cache.generation,
            "task",
            kind,
            kind === "workspace" ? "workspace" : kind,
            "",
            "lost",
          );
        const page = cache.review(r.since);
        expect(page.rows.every((v) => v.family !== "task")).toBe(true);
        expect(page.total).toBe(300);
        expect(page.unavailable).toBe(1);
        cache.db.exec("DELETE FROM access");
      }
      cache.db
        .query("INSERT INTO access VALUES(?,?,?,?,?,?)")
        .run(r.cache.generation, "task", "channel", "other", "", "lost");
      expect(cache.review(r.since).total).toBe(650);
      cache.db.exec("DELETE FROM access");
      cache.db
        .query("UPDATE rows SET resource_kind='note' WHERE family='task'")
        .run();
      cache.db
        .query("INSERT INTO access VALUES(?,?,?,?,?,?)")
        .run(r.cache.generation, "task", "channel", "channel", "other", "lost");
      expect(cache.review(r.since).total).toBe(650);
      cache.db.query("UPDATE access SET resource_kind='note'").run();
      expect(cache.review(r.since).total).toBe(300);
      cache.db.exec("DELETE FROM access");
      const token = cache.review(r.since).nextCursor!;
      cache.unavailable();
      expect(() => cache.review(r.since, 262144, 200, token)).toThrow(
        "unavailable",
      );
      // Simulate a committed access revision change while retaining downloaded evidence.
      const original = cache.state();
      original.available = true;
      original.handoverDone = true;
      for (const patch of [
        { cursor: "different" },
        { generation: "different" },
        { epoch: "different" },
      ]) {
        cache.db
          .query("UPDATE meta SET state=? WHERE id=1")
          .run(JSON.stringify({ ...original, ...patch }));
        expect(() => cache.review(r.since, 262144, 200, token)).toThrow(
          "checkpoint changed",
        );
      }
      const state = original;
      state.available = true;
      state.accessRevision = "2";
      cache.db
        .query("UPDATE meta SET state=? WHERE id=1")
        .run(JSON.stringify(state));
      expect(() => cache.review(r.since, 262144, 200, token)).toThrow(
        "checkpoint changed",
      );
      expect(cache.counts().task).toBe(351);
    } finally {
      cache.close();
    }
  } finally {
    rmSync(f.cacheRoot, { recursive: true, force: true });
  }
});

test("continuation is isolated by cache partition and canonical history is not duplicated", async () => {
  const a = reviewFixture();
  const b = reviewFixture();
  try {
    const first = await a.run();
    await b.run();
    await expect(
      b.run({ reviewOnly: true, reviewCursor: first.review.nextCursor! }),
    ).rejects.toThrow("missing");
    const db = new Database(first.cache.path, { readonly: true });
    try {
      expect(
        (
          db.query("SELECT count(*) AS n FROM review_continuations").get() as {
            n: number;
          }
        ).n,
      ).toBe(1);
      expect(
        db.query("SELECT position FROM review_continuations").get(),
      ).not.toHaveProperty("payload");
      expect(() =>
        readCacheReview(
          db,
          {
            ...JSON.parse(
              (db.query("SELECT state FROM meta").get() as { state: string })
                .state,
            ),
            available: false,
          },
          first.since,
          262144,
          200,
          first.review.nextCursor!,
        ),
      ).toThrow("unavailable");
    } finally {
      db.close();
    }
  } finally {
    rmSync(a.cacheRoot, { recursive: true, force: true });
    rmSync(b.cacheRoot, { recursive: true, force: true });
  }
});

test("UTF-8 summary byte boundary continues all recent records without duplicates", async () => {
  const now = new Date().toISOString();
  const rows = Array.from({ length: 201 }, (_, i) =>
    change(String(i), "message", "1", {
      updated_at: now,
      body: "😀".repeat(1000),
    }),
  );
  const f = fixture([
    pagePayload(rows.slice(0, 200), false, { snapshot_complete: false }),
    pagePayload(rows.slice(200)),
    pagePayload([], true),
  ]);
  try {
    let r = await f.run();
    expect(r.workspaces[0]!.review.length).toBeLessThan(200);
    const ids = new Set<string>();
    do {
      const page = r.workspaces[0]!.review;
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
        262144,
      );
      for (const row of page) {
        expect(ids.has(String(row.id))).toBe(false);
        ids.add(String(row.id));
      }
      if (!r.review.nextCursor) break;
      r = await f.run({ reviewOnly: true, reviewCursor: r.review.nextCursor });
    } while (true);
    expect(ids.size).toBe(201);
    expect(r.review.delivered).toBe(201);
    expect(r.complete).toBe(true);
  } finally {
    rmSync(f.cacheRoot, { recursive: true, force: true });
  }
});

test("deleted partitions remain excluded while revocation, restoration and regrant stay truthful", async () => {
  const f = fixture([
    pagePayload([
      change("scope", "scope", "1"),
      change("channel", "channel", "1"),
      change("retained", "task", "1", { state: "in_progress" }),
    ]),
    pagePayload([], true),
    pagePayload([], true),
  ]);
  try {
    const initial = await f.run();
    const cache = new RecordSyncCache(initial.cache.path, ["https://tower.test", "workspace", "app", "viewer"]);
    try {
      for (const [family, kind, resource] of [["task", "channel", "channel"], ["message", "channel", "channel"], ["task", "scope", "scope"], ["doc", "channel", "unknown"]]) {
        cache.db.query("INSERT INTO access VALUES(?,?,?,?,?,?)").run(initial.cache.generation, family, kind, resource, "", "lost");
      }
      expect(cache.authority()).toEqual({ unavailable: 4, deletedPartitions: 0 });
      cache.db.query("UPDATE rows SET operation='delete',payload=NULL WHERE family='scope'").run();
      expect(cache.authority()).toEqual({ unavailable: 1, deletedPartitions: 3 });
      expect(cache.review(initial.since).rows.some(r => r.id === "retained")).toBe(false);
      cache.db.query("UPDATE rows SET operation='delete',payload=NULL WHERE family='channel'").run();
      expect(cache.authority()).toEqual({ unavailable: 1, deletedPartitions: 3 });
      // Restoration invalidates the deletion classification; grants alone restore read authority.
      cache.db.query("UPDATE rows SET operation='upsert' WHERE family IN ('scope','channel')").run();
      expect(cache.authority()).toEqual({ unavailable: 4, deletedPartitions: 0 });
      cache.db.query("UPDATE access SET status='granted'").run();
      expect(cache.authority()).toEqual({ unavailable: 0, deletedPartitions: 0 });
      expect(cache.review(initial.since).rows.some(r => r.id === "retained")).toBe(true);
      cache.db.query("UPDATE access SET status='lost'").run();
    } finally { cache.close(); }
    const sync = await f.run({ syncOnly: true });
    const review = await f.run({ reviewOnly: true });
    expect(sync.coverage.unavailablePartitions).toBe(4);
    expect(sync.coverage.unavailablePartitions).toBe(review.coverage.unavailablePartitions);
    expect(sync.coverage.deletedPartitions).toBe(review.coverage.deletedPartitions);
    expect(sync.review.started).toBe(false);
    expect(sync.complete).toBe(false);
    expect(review.complete).toBe(false);
  } finally { rmSync(f.cacheRoot, { recursive: true, force: true }); }
});

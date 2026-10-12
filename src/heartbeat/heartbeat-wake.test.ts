import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rmSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import {
  fixture,
  change,
  pagePayload,
  families,
} from "./record-sync-fixture.test-helper.ts";
import { MAX_BYTES } from "./record-sync-protocol.ts";

describe("negotiated heartbeat", () => {
  test("traverses families, delta handover and hashes exact empty registration and ack bodies", async () => {
    const f = fixture([pagePayload([change("task")]), pagePayload([], true)]);
    try {
      const r = await f.run();
      expect(r.complete).toBe(true);
      expect(r.coverage.certifiedBoundary).toBe(true);
      expect(r.coverage.completedFamilies).toEqual(families);
      expect(r.cache.pendingAck).toBe(false);
      expect(r).not.toHaveProperty("rawPages");
      expect(f.calls.some((c) => c.url.pathname.endsWith("/sync"))).toBe(false);
      for (const c of f.calls.filter((c) => c.method === "POST")) {
        expect(
          f.signs.some(
            (s) =>
              s.url === c.url.toString() &&
              s.method === "POST" &&
              s.bodyHash === createHash("sha256").update(c.body).digest("hex"),
          ),
        ).toBe(true);
      }
      const pages = f.calls.filter((c) =>
        c.url.pathname.endsWith("/record-sync"),
      );
      expect(pages[0]!.url.searchParams.get("limit")).toBe("200");
      expect(pages[0]!.url.searchParams.get("extension")).toBe(
        "bounded_snapshot_v1",
      );
      expect(pages[1]!.url.searchParams.get("cursor")).toBe("opaque-1");
    } finally {
      rmSync(f.cacheRoot, { recursive: true, force: true });
    }
  });
  test("pending ack resumes before paging after failure/reopen; no server-only cursor adoption", async () => {
    const f = fixture([
      pagePayload([change("committed")]),
      pagePayload([], true),
    ]);
    try {
      f.setAckFailures(3);
      const first = await f.run();
      expect(first.complete).toBe(false);
      expect(first.cache.pendingAck).toBe(true);
      const n = f.calls.length;
      const second = await f.run();
      expect(second.complete).toBe(true);
      expect(second.cache.clientId).toBe(first.cache.clientId);
      const resumed = f.calls.slice(n);
      expect(
        resumed.findIndex((c) => c.url.pathname.endsWith("/ack")),
      ).toBeLessThan(
        resumed.findIndex((c) => c.url.pathname.endsWith("/record-sync")),
      );
      expect(second.coverage.downloadedCounts.task).toBe(1);
    } finally {
      rmSync(f.cacheRoot, { recursive: true, force: true });
    }
  });
  test("cache loss creates a fresh client and snapshot", async () => {
    const f = fixture([
      pagePayload([change("old")]),
      pagePayload([], true),
      pagePayload([change("new")]),
      pagePayload([], true),
    ]);
    try {
      const a = await f.run();
      rmSync(f.cacheRoot, { recursive: true, force: true });
      const b = await f.run();
      expect(b.cache.clientId).not.toBe(a.cache.clientId);
      expect(b.coverage.downloadedCounts.task).toBe(1);
    } finally {
      rmSync(f.cacheRoot, { recursive: true, force: true });
    }
  });
  test("token expiry preserves downloads and repairs with fresh identity", async () => {
    const f = fixture([pagePayload([change("retained")])], { maxPages: 1 });
    try {
      const a = await f.run();
      f.setPageError("page_token_invalid");
      const b = await f.run();
      expect(b.complete).toBe(false);
      expect(b.cache.clientId).not.toBe(a.cache.clientId);
      const db = new Database(a.cache.path, { readonly: true });
      expect(
        (db.query("SELECT count(*) AS n FROM rows").get() as { n: number }).n,
      ).toBe(1);
      db.close();
      f.setPageError(null);
      const c = await f.run();
      expect(c.cache.clientId).toBe(b.cache.clientId);
    } finally {
      rmSync(f.cacheRoot, { recursive: true, force: true });
    }
  });
  test("missing extension, page/time budgets and oversized responses never certify absence", async () => {
    const f = fixture([pagePayload(), pagePayload([], true)]);
    try {
      f.setExtension(false);
      const a = await f.run();
      expect(a.complete).toBe(false);
      expect(a.errors.join()).toContain("not negotiated");
      await expect(f.run({ maxPages: Infinity })).rejects.toThrow("finite");
      const b = await f.run({ maxTimeMs: 29999 });
      expect(b.complete).toBe(false);
      expect(b.errors.join()).toContain("budget");
    } finally {
      rmSync(f.cacheRoot, { recursive: true, force: true });
    }
    const big = fixture([
      pagePayload([
        change("huge", "task", "1", { body: "x".repeat(MAX_BYTES) }),
      ]),
    ]);
    try {
      const r = await big.run();
      expect(r.complete).toBe(false);
      expect(r.errors.join()).toContain("1 MiB");
      expect(r.coverage.downloadedCounts).toEqual({});
    } finally {
      rmSync(big.cacheRoot, { recursive: true, force: true });
    }
  });
  test("fixed target mutation and mismatched certificates fail without advancing rows", async () => {
    const f = fixture([
      pagePayload([change("a")]),
      pagePayload([change("b")], true, {
        handover: {
          target_position: "9007199254740994",
          through_position: "9007199254740994",
          complete: true,
          authority_epoch: "epoch",
          access_revision: "1",
        },
      }),
    ]);
    try {
      const r = await f.run();
      expect(r.complete).toBe(false);
      expect(r.errors.join()).toContain("target changed");
      expect(r.coverage.downloadedCounts.task).toBe(1);
    } finally {
      rmSync(f.cacheRoot, { recursive: true, force: true });
    }
  });
  test("large multi-family fixtures over 10k per family and 100k messages retain all data across wakes", async () => {
    const pages = [];
    for (const family of families) {
      const n = family === "message" ? 100001 : 10001;
      for (let i = 0; i < n; i += 200)
        pages.push(
          pagePayload(
            Array.from({ length: Math.min(200, n - i) }, (_, j) =>
              change(`${family}-${i + j}`, family),
            ),
            false,
            { snapshot_complete: false, partitions_complete: [] },
          ),
        );
    }
    pages.push(pagePayload(), pagePayload([], true));
    const f = fixture(pages, { maxPages: 5000 });
    try {
      const r = await f.run();
      expect(r.complete).toBe(true);
      for (const family of families)
        expect(r.coverage.downloadedCounts[family]).toBe(
          family === "message" ? 100001 : 10001,
        );
      expect(
        r.timings.transfers.every((t) => t.decodedBytes <= MAX_BYTES),
      ).toBe(true);
      expect(r.workspaces[0]!.review).toEqual([]);
    } finally {
      rmSync(f.cacheRoot, { recursive: true, force: true });
    }
  }, 120000);
  test("recent review is bounded and cannot claim complete if summaries truncate", async () => {
    const f = fixture([
      pagePayload(
        Array.from({ length: 200 }, (_, i) =>
          change(String(i), "task", "1", {
            updated_at: new Date().toISOString(),
            body: "x".repeat(300),
          }),
        ),
      ),
      pagePayload(
        [change("more", "task", "1", { updated_at: new Date().toISOString() })],
        true,
      ),
    ]);
    try {
      const r = await f.run();
      expect(r.complete).toBe(false);
      expect(r.coverage.reviewTruncated).toBe(true);
      expect(r.workspaces[0]!.review.length).toBeLessThanOrEqual(200);
    } finally {
      rmSync(f.cacheRoot, { recursive: true, force: true });
    }
  });
  test("production source CLI smoke uses Bun-native SQLite", () => {
    const r = spawnSync("bun", ["clis/heartbeat-wake.ts", "--smoke"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).ok).toBe(true);
    expect(r.stderr).not.toContain("better-sqlite3");
  });
});
test("2095 substantial comments traverse independent family pages without parent fanout", async () => {
  const pages = [];
  for (let i = 0; i < 2095; i += 200)
    pages.push(
      pagePayload(
        Array.from({ length: Math.min(200, 2095 - i) }, (_, j) =>
          change(String(i + j), "task_comment", "1", {
            task_id: `parent-${(i + j) % 349}`,
            body: "x".repeat(4000),
          }),
        ),
        false,
        { snapshot_complete: false, partitions_complete: [] },
      ),
    );
  pages.push(pagePayload(), pagePayload([], true));
  const f = fixture(pages);
  try {
    const r = await f.run();
    expect(r.complete).toBe(true);
    expect(r.coverage.downloadedCounts.task_comment).toBe(2095);
    expect(f.calls.every((c) => !c.url.pathname.includes("/tasks/"))).toBe(
      true,
    );
    expect(r.timings.transfers.every((t) => t.decodedBytes <= MAX_BYTES)).toBe(
      true,
    );
  } finally {
    rmSync(f.cacheRoot, { recursive: true, force: true });
  }
});
test("host-selected FIPS transport signs the selected exact URL and preserves all v2 page queries", async () => {
  const f = fixture([pagePayload([change("bound")]), pagePayload([], true)]);
  f.setBound(true);
  try {
    const r = await f.run();
    expect(r.complete).toBe(true);
    expect(f.calls.every((c) => c.url.hostname === "node.fips")).toBe(true);
    expect(
      f.signs.every((s) => String(s.url).startsWith("http://node.fips:43100")),
    ).toBe(true);
    expect(
      r.timings.transfers.every((t) => t.selectedTransport === "fips"),
    ).toBe(true);
  } finally {
    rmSync(f.cacheRoot, { recursive: true, force: true });
  }
});
test("partial snapshot persists across wakes, unauthorized future reads retain rows without current evidence", async () => {
  const f = fixture([
    pagePayload([change("one")], false, {
      snapshot_complete: false,
      partitions_complete: [],
    }),
    pagePayload([change("two")]),
    pagePayload([], true),
  ]);
  try {
    const a = await f.run({ maxPages: 1 });
    expect(a.complete).toBe(false);
    expect(a.coverage.snapshotComplete).toBe(false);
    const b = await f.run();
    expect(b.complete).toBe(true);
    expect(b.cache.clientId).toBe(a.cache.clientId);
    expect(b.coverage.downloadedCounts.task).toBe(2);
    const original = f.context.fetch!;
    const denied = (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) =>
      new URL(String(input)).pathname.endsWith("/record-sync")
        ? Response.json(
            { error: "workspace_membership_required" },
            { status: 403 },
          )
        : original(input, init)) as typeof fetch;
    const c = await f.run({ fetchImpl: denied });
    expect(c.complete).toBe(false);
    expect(c.coverage.downloadedCounts.task).toBe(2);
    expect(c.workspaces[0]!.review).toEqual([]);
    expect(c.coverage.certifiedBoundary).toBe(false);
  } finally {
    rmSync(f.cacheRoot, { recursive: true, force: true });
  }
});

test("direct source CLI writes durable partial evidence and exits two without restarting host", () => {
  const root = mkdtempSync(join(tmpdir(), "source-cli-v2-"));
  const preload = join(root, "mock.ts");
  const output = join(root, "evidence.json");
  try {
    writeFileSync(preload, `let client="";
      globalThis.fetch = async (input, init) => {
        const url=new URL(String(input));
        if (url.pathname.includes("/identity")) return Response.json({identityType:"agent",botNpub:"viewer"});
        if (url.pathname.includes("/nip98")) return Response.json({token:"Nostr fixture"});
        if (url.pathname === "/api/mcp/wingman/flightdeck") return Response.json({workspace:null});
        if (url.pathname.endsWith("/service")) return Response.json({record_sync:{protocol_versions:[2],device_checkpoints:true,additive_access:true,retention_policy:"retain_downloaded",extensions:["bounded_snapshot_v1"]}});
        if (url.pathname.includes("/clients/")) {
          client=url.pathname.split("/clients/")[1].split("/")[0];
          return Response.json({protocol_version:2,client_id:client,authority_epoch:"epoch",initial_cursor:"initial",checkpoint_cursor:url.pathname.endsWith("/ack") ? "page" : null,checkpoint_revision:url.pathname.endsWith("/ack") ? "1" : "0"});
        }
        return Response.json({...${JSON.stringify(pagePayload([change("durable")], false, {snapshot_complete:false,partitions_complete:[]}))},client_id:client,next_cursor:"page"});
      };`);
    const result=spawnSync("bun",["--preload",preload,"clis/heartbeat-wake.ts","--workspace","workspace","--tower-url","https://tower.test","--app-npub","app","--cache-dir",join(root,"cache"),"--max-pages","1","--output",output],{encoding:"utf8",env:{...process.env,WINGMAN_BROKER_URL:"https://broker.test",SESSION_ID:"source-cli-fixture",WINGMAN_CAPABILITY:"fixture"}});
    expect(result.status).toBe(2);
    const evidence=JSON.parse(readFileSync(output,"utf8"));
    expect(evidence.complete).toBe(false);expect(evidence.coverage.downloadedCounts.task).toBe(1);expect(evidence.cache.pendingAck).toBe(false);expect(evidence).not.toHaveProperty("rawPages");
  } finally {rmSync(root,{recursive:true,force:true});}
});

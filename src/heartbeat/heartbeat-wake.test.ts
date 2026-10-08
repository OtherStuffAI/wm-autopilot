import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { snapshotSaturation } from "./snapshot-saturation.ts";
import { runHeartbeatWake, type HeartbeatWakeOptions } from "./heartbeat-wake";

const cursor = (channelId: string, messageId: string | null = null) => Buffer.from(JSON.stringify({ version: 2, kind: "workspace_snapshot", channelId, messageId })).toString("base64url");
function page(channel: string, more: boolean, next: string, messages = [{ id: `${channel}-message` }]) {
  return { identity: { workspace_id: "home", app_npub: "app", tower_service_npub: "tower" }, mode: "snapshot", full_snapshot: true,
    channels: [{ id: "a" }, { id: "b" }], scopes: [{ id: "scope" }], members: [{ actor: { id: "actor" } }],
    channel_bundles: [{ channel_id: channel, messages, tasks: [{ id: `${channel}-old-open`, created_at: "2020-01-01", state: "open" }], task_comments: [], threads: [], docs: [], doc_comments: [], files: [], file_folders: [], audio_notes: [] }],
    has_more: more, snapshot_complete: !more, next_cursor: next };
}
function fixture(pages: unknown[], overrides: Partial<HeartbeatWakeOptions> = {}, active: Record<string, unknown> = { workspaceId: "home", backendBaseUrl: "https://tower.test", sourceAppNpub: "app" }) {
  const calls: URL[] = [];
  let index = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url);
    if (url.pathname === "/api/mcp/wingman/flightdeck") return Response.json({ workspace: active });
    if (url.pathname === "/api/mcp/capabilities/identity") return Response.json({ identityType: "agent", botNpub: "bot" });
    if (url.pathname === "/api/mcp/capabilities/nip98") return Response.json({ token: "Nostr signed" });
    if (url.pathname.endsWith("/sync")) {
      const item = pages[index++];
      if (item instanceof Error) throw item;
      if (item instanceof Response) return item;
      if (item === "hang") return await new Promise<Response>(() => {});
      return Response.json(item);
    }
    throw new Error(`Unexpected request ${url}`);
  }) as typeof fetch;
  return { calls, run: () => runHeartbeatWake({ hours: 12, context: { wingmanUrl: "https://broker.test", sessionId: crypto.randomUUID(), capabilityToken: "cap", fetch: fetchImpl }, ...overrides }) };
}

describe("heartbeat full workspace snapshot", () => {
  test("merges repeated pages across channels, keeps old open work and stops at terminal non-null cursor", async () => {
    const f = fixture([page("a", true, cursor("a", "m1")), page("a", true, cursor("b"), [{ id: "a-message" }, { id: "a-second" }]), page("b", false, "terminal-event-cursor")]);
    const result = await f.run();
    expect(result.complete).toBe(true);
    expect(result.coverage).toMatchObject({ pages: 3, visibleChannels: 2, completedChannels: 2, missingChannelIds: [], counts: { messages: 3, tasks: 2 } });
    const bundles = result.workspaces[0]!.sync.channel_bundles as Array<{ tasks: Array<{ created_at: string }> }>;
    expect(bundles[0]!.tasks[0]!.created_at).toBe("2020-01-01");
    const requests = f.calls.filter(url => url.pathname.endsWith("/sync"));
    expect(requests).toHaveLength(3);
    expect(requests[0]!.searchParams.has("cursor")).toBe(false);
    expect(requests.every(url => !url.searchParams.has("since"))).toBe(true);
    expect(f.calls.some(url => url.pathname.endsWith("/workspaces"))).toBe(false);
  });
  test("page cap preserves evidence and identifies unfinished and missing channels", async () => {
    const result = await fixture([page("a", true, cursor("a", "m"))], { maxPages: 1 }).run();
    expect(result.complete).toBe(false);
    expect(result.coverage.missingChannelIds).toEqual(["a", "b"]);
    expect(result.rawPages).toHaveLength(1);
    expect(result.coverage.counts.tasks).toBe(1);
    expect(result.errors[0]).toContain("page budget");
  });
  test("repeated cursor is incomplete", async () => {
    const result = await fixture([page("a", true, cursor("b")), page("b", true, cursor("b"))]).run();
    expect(result.complete).toBe(false);
    expect(result.errors[0]).toContain("repeated");
    expect(result.coverage.missingChannelIds).toEqual(["b"]);
  });
  for (const failure of [new Error("network failure"), new Response('{"error":"denied"}', { status: 403 })]) {
    test(`preserves prior pages on ${failure instanceof Error ? "network" : "HTTP"} failure`, async () => {
      const result = await fixture([page("a", true, cursor("b")), failure]).run();
      expect(result.complete).toBe(false);
      expect(result.coverage.counts.tasks).toBe(1);
      expect(result.coverage.missingChannelIds).toEqual(["b"]);
      expect(result.errors).toHaveLength(1);
    });
  }
  test("rejects mismatched identity without merging its records", async () => {
    const bad = page("b", false, "terminal"); bad.identity.workspace_id = "other";
    const result = await fixture([page("a", true, cursor("b")), bad]).run();
    expect(result.complete).toBe(false);
    expect(result.errors[0]).toContain("identity mismatch");
    expect(result.coverage.counts.tasks).toBe(1);
    expect(result.rawPages).toHaveLength(2);
  });
  test("terminal response missing a visible bundle remains incomplete", async () => {
    const result = await fixture([page("a", false, "terminal")]).run();
    expect(result.complete).toBe(false);
    expect(result.coverage.missingChannelIds).toEqual(["b"]);
  });
  test("rejects delta and inconsistent completion metadata", async () => {
    for (const bad of [{ ...page("a", false, "terminal"), mode: "delta" }, { ...page("a", false, "terminal"), snapshot_complete: false }]) {
      expect((await fixture([bad]).run()).errors[0]).toContain("completion metadata");
    }
  });
  test("request timeout preserves partial evidence", async () => {
    const result = await fixture([page("a", true, cursor("b")), "hang"], { requestTimeoutMs: 20 }).run();
    expect(result.complete).toBe(false);
    expect(result.errors[0]).toContain("timed out");
    expect(result.coverage.counts.tasks).toBe(1);
  });
  test("total time bounds a hanging request", async () => {
    const result = await fixture(["hang"], { maxTimeMs: 20, requestTimeoutMs: 1000 }).run();
    expect(result.complete).toBe(false);
    expect(result.errors[0]).toContain("timed out");
  });
  test("requires workspace and namespace and rejects conflicting overrides", async () => {
    await expect(fixture([], {}, { backendBaseUrl: "https://tower.test", sourceAppNpub: "app" }).run()).rejects.toThrow("--workspace");
    await expect(fixture([], { workspaceId: "home" }, {}).run()).rejects.toThrow("explicit --workspace");
    await expect(fixture([], { towerUrl: "http://localhost" }).run()).rejects.toThrow("override");
    await expect(fixture([], { maxPages: Infinity }).run()).rejects.toThrow("finite");
  });
  test("unbound scheduler context accepts only a complete explicit target", async () => {
    const p = page("a", false, "terminal"); p.channels = [{ id: "a" }];
    const options = { workspaceId: "home", towerUrl: "https://tower.test", appNpub: "app" };
    expect((await fixture([p], options, {}).run()).complete).toBe(true);
    for (const partial of [{ workspaceId: "home" }, { towerUrl: "https://tower.test", appNpub: "app" }]) {
      await expect(fixture([], partial, {}).run()).rejects.toThrow();
    }
    const bad = { ...p, identity: { ...p.identity, app_npub: "wrong" } };
    expect((await fixture([bad], options, {}).run()).errors[0]).toContain("identity mismatch");
  });
  test("explicit target does not hide broker context authorization failures", async () => {
    const f = fixture([], { workspaceId: "home", towerUrl: "https://tower.test", appNpub: "app",
      fetchImpl: (async () => Response.json({ error: "Capability denied" }, { status: 403 })) as typeof fetch });
    await expect(f.run()).rejects.toThrow("Capability denied");
    expect(f.calls).toHaveLength(0);
  });
  test("possible collection saturation keeps evidence but prevents complete coverage", async () => {
    const p = page("a", false, "terminal"); p.channels = [{ id: "a" }];
    const tasks = Array.from({ length: 10000 }, (_, i) => ({ id: `task-${i}` }));
    const saturated = { ...p, channel_bundles: [{ ...p.channel_bundles[0], tasks }] };
    const result = await fixture([saturated]).run();
    expect(result.complete).toBe(false);
    expect(result.coverage.counts.tasks).toBe(10000);
    expect(result.coverage.possibleSaturation).toEqual([{ collection: "tasks", channelId: "a", observedCount: 10000, possibleLimit: 10000 }]);
    expect(result.rawPages).toHaveLength(1);
    expect(snapshotSaturation({ scopes: tasks, channels: tasks, channel_bundles: [{ channel_id: "a", messages: tasks, task_comments: tasks }] }).map(row => row.collection)).toEqual(["scopes", "channels", "task_comments"]);
    expect(snapshotSaturation({ tasks: tasks.slice(0, 9999), channel_bundles: [{ channel_id: "a", tasks: tasks.slice(0, 9999) }] })).toEqual([]);
  });
  test("explicit workspace selects only that workspace", async () => {
    const p = page("a", false, "terminal"); p.identity.workspace_id = "chosen"; p.channels = [{ id: "a" }];
    const f = fixture([p], { workspaceId: "chosen" });
    expect((await f.run()).complete).toBe(true);
    expect(f.calls.filter(url => url.pathname.endsWith("/sync"))[0]!.pathname).toContain("/chosen/sync");
  });
  test("CLI writes partial JSON evidence to output and exits nonzero", () => {
    const directory = mkdtempSync(join(tmpdir(), "heartbeat-cli-"));
    try {
      const preload = join(directory, "mock.ts");
      const output = join(directory, "evidence.json");
      writeFileSync(preload, `globalThis.fetch = async input => {
        const path = new URL(String(input)).pathname;
        if (path.includes("/identity")) return Response.json({identityType:"agent",botNpub:"bot"});
        if (path.includes("/nip98")) return Response.json({token:"Nostr signed"});
        if (path === "/api/mcp/wingman/flightdeck") return Response.json({workspace:null});
        return Response.json(${JSON.stringify(page("a", true, cursor("b")))});
      };`);
      const result = spawnSync("bun", ["--preload", preload, "clis/heartbeat-wake.ts", "--workspace", "home", "--tower-url", "https://tower.test", "--app-npub", "app", "--json", "--max-pages", "1", "--output", output], {
        cwd: fileURLToPath(new URL("../..", import.meta.url)), encoding: "utf8",
        env: { ...process.env, WINGMAN_BROKER_URL: "https://broker.test", SESSION_ID: "cli-test", WINGMAN_CAPABILITY: "cap" },
      });
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).complete).toBe(false);
      const evidence = JSON.parse(readFileSync(output, "utf8"));
      expect(evidence.rawPages).toHaveLength(1);
      expect(evidence.coverage.missingChannelIds).toEqual(["b"]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  test("production CLI smoke has no native SQLite dependency", () => {
    const result = spawnSync("bun", ["clis/heartbeat-wake.ts", "--smoke"], { cwd: fileURLToPath(new URL("../..", import.meta.url)), encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, runtime: "bun", sqlite: "bun-native-or-none" });
    expect(result.stderr).not.toContain("better-sqlite3");
  });
});

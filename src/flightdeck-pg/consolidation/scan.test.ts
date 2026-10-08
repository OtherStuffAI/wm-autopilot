import { expect, test } from "bun:test";
import { linkExistingTask } from "./reconcile.ts";
import { scanTasks, type ScanConfig, type ScanClient, type ScanResult } from "./scan.ts";

const config: ScanConfig = { workspace_id: "w", scope_id: "s", channels: ["a", "b"].map(id => ({ id, name: id, scope_id: "s" })) };
function task(id: string, channel = "a", row_version = 1) {
  return { id, channel_id: channel, workspace_id: "w", row_version, updated_at: "2026-10-01T00:00:00.123456Z" };
}
function fixture(read: ScanClient["listTasks"]): ScanClient {
  return {
    listChannels: async () => ({ channels: config.channels.map(c => ({ ...c, workspace_id: "w" })), next_cursor: null }),
    showChannel: async (_w, id) => ({ channel: { ...config.channels.find(c => c.id === id), workspace_id: "w" } }),
    listTasks: read,
  };
}
test("sequential opaque tied-timestamp pages find older matches beyond 200 without duplicates", async () => {
  let active = 0;
  const cursors: Array<string | null | undefined> = [];
  const client = fixture(async (_w, input) => {
    expect(active++).toBe(0);
    await Promise.resolve();
    cursors.push(input.cursor);
    const index = input.cursor ? Number(input.cursor.split("/")[1]) : 0;
    const size = input.channelId === "a" ? 250 : 5;
    const tasks = Array.from({ length: Math.min(100, size - index) }, (_, n) => task(`${input.channelId}-${n + index}`, input.channelId));
    const next_cursor = index + 100 < size ? `opaque/${index + 100}/timestamp-tie` : null;
    active--;
    return { channel_id: input.channelId, tasks, next_cursor, has_more: next_cursor !== null };
  });
  const result = await scanTasks(client, config);
  expect(result.complete).toBe(true);
  expect(result.tasks.length).toBe(255);
  expect(result.pages_read).toBe(4);
  expect(result.tasks.some(t => t.id === "a-249")).toBe(true);
  expect(cursors).toEqual([null, "opaque/100/timestamp-tie", "opaque/200/timestamp-tie", null]);
  const older = { ...result.tasks.find(t => t.id === "a-249")!, state: "review", assigned_to_npub: "human" };
  const comments: Array<{ body: string }> = [];
  let commentWrites = 0;
  let proposalCreates = 0;
  const reconcileClient = {
    showTask: async () => ({ task: older }),
    listTaskComments: async () => ({ comments, next_cursor: null }),
    commentTask: async (_w: string, _t: string, body: string) => { commentWrites++; comments.push({ body }); return {}; },
    createTask: async () => { proposalCreates++; return {}; },
  };
  const input = { workspace: "w", channel: "a", task: String(older.id), body: "Specific batch already routed" };
  const intent = { body: input.body, attempted: false };
  expect(await linkExistingTask(reconcileClient, input, intent, async () => {})).toBe("linked");
  expect(await linkExistingTask(reconcileClient, input, intent, async () => {})).toBe("unchanged");
  expect(commentWrites).toBe(1);
  expect(proposalCreates).toBe(0);
  expect(older.state).toBe("review");
  expect(older.assigned_to_npub).toBe("human");
});
test("interrupted page preserves durable cursor and retries it without skipping or duplicating", async () => {
  let fail = true;
  let saved: ScanResult | undefined;
  const seen: Array<string | null | undefined> = [];
  const client = fixture(async (_w, i) => {
    seen.push(i.cursor);
    if (i.channelId === "b") return { channel_id: "b", tasks: [], next_cursor: null, has_more: false };
    if (i.cursor && fail) throw new Error("interrupted");
    return { channel_id: "a", tasks: [task(i.cursor ? "old" : "new")], next_cursor: i.cursor ? null : "opaque", has_more: !i.cursor };
  });
  const first = await scanTasks(client, config, { save: async s => { saved = s; } });
  expect(first.complete).toBe(false);
  expect(saved?.progress.a?.cursor).toBe("opaque");
  fail = false;
  const second = await scanTasks(client, config, { resume: saved });
  expect(second.complete).toBe(true);
  expect(second.tasks.map(t => t.id)).toEqual(["new", "old"]);
  expect(seen).toEqual([null, "opaque", null, "opaque"]);
});
test("repeated/invalid cursor and unique cursor budget terminate explicitly partial", async () => {
  for (const next of ["repeat", "", undefined, 5]) {
    const result = await scanTasks(fixture(async (_w, i) => ({ channel_id: i.channelId, tasks: [task("t", i.channelId)], next_cursor: next, has_more: true })), config);
    expect(result.complete).toBe(false);
    expect(result.requests).toBeLessThan(8);
  }
  const invalid = await scanTasks(fixture(async () => { throw Object.assign(new Error("private"), { status: 400 }); }), config);
  expect(invalid.gaps[0]?.reason).toBe("invalid_cursor");
  let n = 0;
  const bounded = await scanTasks(fixture(async (_w, i) => ({ channel_id: i.channelId, tasks: [task(`${n}`, i.channelId)], next_cursor: String(++n), has_more: true })), config, { maxPages: 2 });
  expect(bounded.pages_read).toBe(2);
  expect(bounded.complete).toBe(false);
  expect(bounded.gaps[0]?.reason).toBe("page_budget");
});
test("hidden map and full-size null-cursor enumeration cannot claim completeness", async () => {
  for (const channels of [[], Array.from({ length: 200 }, () => ({ id: "a" }))]) {
    const client = fixture(async () => { throw new Error("must not read tasks"); });
    client.listChannels = async () => ({ channels, next_cursor: null });
    const result = await scanTasks(client, config);
    expect(result.complete).toBe(false);
    expect(result.tasks).toEqual([]);
    expect(result.pages_read).toBe(0);
  }
});
test("cross-workspace tasks rejected; revoked access stops after twice and drops cached private records", async () => {
  const leaked = await scanTasks(fixture(async (_w, i) => ({ channel_id: i.channelId, tasks: [{ ...task("x", i.channelId), workspace_id: "other" }], next_cursor: null, has_more: false })), config);
  expect(leaked.complete).toBe(false);
  expect(leaked.tasks).toEqual([]);
  const initial = await scanTasks(fixture(async (_w, i) => ({ channel_id: i.channelId, tasks: [task(i.channelId, i.channelId)], next_cursor: null, has_more: false })), config);
  const client = fixture(async () => { throw new Error("must not read"); });
  let denied = 0;
  client.showChannel = async () => { denied++; throw Object.assign(new Error("secret"), { status: 403 }); };
  const revoked = await scanTasks(client, config, { resume: initial });
  expect(denied).toBe(2);
  expect(revoked.tasks).toEqual([]);
  expect(revoked.complete).toBe(false);
});
test("rate limit preserves collected state; persisted page failures never claim complete", async () => {
  let count = 0;
  const result = await scanTasks(fixture(async (_w, i) => {
    if (++count === 2) throw Object.assign(new Error("private"), { status: 429 });
    return { channel_id: i.channelId, tasks: [task("first", i.channelId)], next_cursor: "next", has_more: true };
  }), config);
  expect(result.tasks.length).toBe(1);
  expect(result.complete).toBe(false);
  expect(result.gaps[0]?.reason).toBe("rate_limit");
  await expect(scanTasks(fixture(async (_w, i) => ({ channel_id: i.channelId, tasks: [], next_cursor: null, has_more: false })), config,
    { save: async () => { throw new Error("disk full"); } })).rejects.toThrow();
});
test("resume rejects cached cross-workspace evidence even when marked complete", async () => {
  const valid = await scanTasks(fixture(async (_w, i) => ({ channel_id: i.channelId, tasks: [], next_cursor: null, has_more: false })), config);
  valid.tasks.push({ ...task("private"), workspace_id: "other" });
  await expect(scanTasks(fixture(async () => ({})), config, { resume: valid })).rejects.toThrow("Invalid resume");
});

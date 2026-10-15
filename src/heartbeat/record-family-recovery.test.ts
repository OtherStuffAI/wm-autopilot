import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { RecordSyncCache } from "./record-sync-cache.ts";
import { mergeFamilyBootstrap } from "./record-family-recovery.ts";
import { families, fixture, pagePayload, change } from "./record-sync-fixture.test-helper.ts";

const expanded = [...families, "personal_pin"];
async function pair() {
  const primary = fixture([pagePayload([change("task", "task", "1", { state: "review" }), change("task2", "task", "1", { state: "review" })]), pagePayload([], true),
    pagePayload([{ ...change("deleted", "personal_pin", "5"), operation: "delete", row: null }, change("newer", "personal_pin", "6")], true, { families: expanded })]);
  const supplementary = fixture([pagePayload([change("deleted", "personal_pin", "2"), change("newer", "personal_pin", "2"), change("backfill", "personal_pin", "2")], false, { families: expanded, partitions_complete: expanded }), pagePayload([], true, { families: expanded })]);
  const before = await primary.run();
  const incomplete = await primary.run();
  const full = await supplementary.run();
  const partition = ["https://tower.test", "workspace", "app", "viewer"];
  const p = new RecordSyncCache(incomplete.cache.path, partition);
  const s = new RecordSyncCache(full.cache.path, partition);
  return { primary, supplementary, before, incomplete, p, s,
    close() { this.p.close(); this.s.close(); rmSync(primary.cacheRoot, {recursive:true,force:true}); rmSync(supplementary.cacheRoot, {recursive:true,force:true}); } };
}
function mutate(cache: RecordSyncCache, values: Record<string, unknown>) {
  cache.db.query("UPDATE meta SET state=? WHERE id=1").run(JSON.stringify({ ...cache.state(), ...values }));
}

test("supplementary bootstrap preserves primary checkpoints, tombstones and newer rows across reopen", async () => {
  const f = await pair();
  try {
    const before = f.p.state();
    const review = f.p.review("2000-01-01T00:00:00Z", 262144, 1);
    mergeFamilyBootstrap(f.p, f.s, before.generation);
    expect(f.p.state()).toEqual({ ...before, partitions: expanded });
    expect(f.p.pending()).toBeNull();
    expect(f.p.db.query("SELECT operation,version FROM rows WHERE family='personal_pin' AND id='deleted'").get()).toEqual({operation:"delete",version:"5"});
    expect(f.p.db.query("SELECT version FROM rows WHERE family='personal_pin' AND id='newer'").get()).toEqual({version:"6"});
    expect(f.p.counts().personal_pin).toBe(2);
    expect(f.p.db.query("SELECT family FROM family_bootstraps").all()).toEqual([{family:"personal_pin"}]);
    expect(() => f.p.review(review.since,262144,1,review.nextCursor!)).toThrow("Review checkpoint changed");
    mergeFamilyBootstrap(f.p, f.s, before.generation);
    f.p.close();
    const reopened = new RecordSyncCache(f.incomplete.cache.path, f.s.partition);
    try { expect(reopened.state().partitions).toEqual(expanded); expect(reopened.counts().personal_pin).toBe(2); }
    finally { reopened.close(); }
    // Reopen for shared cleanup.
    f.p = new RecordSyncCache(f.incomplete.cache.path, f.s.partition);

  } finally { f.close(); }
});

for (const [label, state] of [
  ["epoch", {epoch:"other"}], ["access", {accessRevision:"2"}],
  ["boundary", {through:"9007199254740994"}], ["unfinished", {partitions:families}],
  ["unavailable", {available:false}], ["partial", {handoverDone:false}],
] as const) {
  test(`bootstrap rejects ${label} proof without changing primary`, async () => {
    const f = await pair();
    try {
      const before=f.p.state(); mutate(f.s, state);
      expect(() => mergeFamilyBootstrap(f.p,f.s,before.generation)).toThrow();
      expect(f.p.state()).toEqual(before);
      expect(f.p.counts().personal_pin).toBe(1);
    } finally { f.close(); }
  });
}

test("bootstrap refuses pending ack, stale generation and expired writer lease", async () => {
  const f=await pair();
  try {
    const before=f.p.state();
    expect(() => mergeFamilyBootstrap(f.p,f.s,"stale")).toThrow("identity changed");
    const s=f.s.state();
    f.s.db.query("INSERT INTO ack_intents VALUES(?,?,?,?, 'pending')").run(s.generation,s.clientId,s.cursor,s.revision);
    expect(() => mergeFamilyBootstrap(f.p,f.s,before.generation)).toThrow("acknowledged terminal");
    f.s.db.exec("DELETE FROM ack_intents");
    f.p.db.exec("UPDATE lease SET expires=0");
    expect(() => mergeFamilyBootstrap(f.p,f.s,before.generation)).toThrow("Stale cache writer lease");
    expect(f.p.state()).toEqual(before);
  } finally { f.close(); }
});

test("recovery resumes supplementary pages across invocations and certifies without reviewing", async () => {
  const { recoverHeartbeatFamilies } = await import("./record-family-recovery.ts");
  const primary = fixture([pagePayload([change("task", "task", "1", {state:"review"})]), pagePayload([],true),
    pagePayload([change("live", "personal_pin", "4")], true, {families:expanded}),
    ...Array.from({length:5}, () => pagePayload([],true,{families:expanded})),
  ]);
  const supplement = fixture([
    pagePayload([change("historic", "personal_pin", "2")],false,{families:expanded,partitions_complete:[],snapshot_complete:false}),
    pagePayload([],false,{families:expanded,partitions_complete:expanded}),
    pagePayload([],true,{families:expanded}),
  ]);
  try {
    const before=await primary.run();
    const clients=new Map<string, typeof fetch>();
    clients.set(before.cache.clientId,primary.context.fetch);
    const multiplex=(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url=new URL(String(input));
      const id=url.pathname.split("/clients/")[1]?.split("/")[0] ?? url.searchParams.get("client_id");
      if (id && !clients.has(id)) clients.set(id,supplement.context.fetch);
      if (id && id !== before.cache.clientId && url.searchParams.has("cursor"))
        expect(() => new RecordSyncCache(before.cache.path,["https://tower.test","workspace","app","viewer"])).toThrow("writer lease");
      return (id ? clients.get(id)! : primary.context.fetch)(input,init);
    }) as typeof fetch;
    const options={hours:12,workspaceId:"workspace",towerUrl:"https://tower.test",appNpub:"app",
      context:{...primary.context,fetch:multiplex},cacheRoot:primary.cacheRoot,maxPages:1};
    supplement.setAckError("test_failure");
    const failed=await recoverHeartbeatFamilies(options,1);
    expect(failed.outcome).toBe("blocked");
    expect(failed.result.cache.pendingAck).toBe(true);
    expect(failed.result.cache.clientId).not.toBe(before.cache.clientId);
    supplement.setAckError(null);
    const partial=await recoverHeartbeatFamilies(options,1);
    expect(partial.outcome).toBe("wake_limit");
    const resumed=await recoverHeartbeatFamilies({...options,maxPages:100},5);
    expect(resumed.outcome).toBe("certified");
    expect(resumed.result.cache.clientId).toBe(before.cache.clientId);
    expect(resumed.result.cache.generation).toBe(before.cache.generation);
    expect(resumed.result.cache.pendingAck).toBe(false);
    expect(resumed.result.coverage.downloadedCounts).toMatchObject({task:1,personal_pin:2});
    expect(resumed.result.coverage.unfinishedFamilies).toEqual([]);
    expect(resumed.result.review.started).toBe(false);
    expect(resumed.result.complete).toBe(false);
    expect(clients.size).toBe(2);
  } finally { rmSync(primary.cacheRoot,{recursive:true,force:true}); rmSync(supplement.cacheRoot,{recursive:true,force:true}); }
});

test("inconsistent imported canonical data rolls back the whole merge", async () => {
  const f=await pair();
  try {
    const before=f.p.state();
    f.s.db.query("UPDATE rows SET version='6',payload=? WHERE family='personal_pin' AND id='newer'").run(JSON.stringify({different:true}));
    expect(() => mergeFamilyBootstrap(f.p,f.s,before.generation)).toThrow("Inconsistent family bootstrap row");
    expect(f.p.state()).toEqual(before);
    expect(f.p.db.query("SELECT id FROM rows WHERE family='personal_pin' AND id='backfill'").get()).toBeNull();
  } finally { f.close(); }
});


test("bootstrap never certifies genuine revoked authority", async () => {
  const f=await pair();
  try {
    const before=f.p.state();
    f.s.db.query("INSERT INTO access VALUES(?,?,?,?,?,?)").run(f.s.state().generation,"personal_pin","workspace","workspace","","lost");
    expect(() => mergeFamilyBootstrap(f.p,f.s,before.generation)).toThrow("acknowledged terminal");
    expect(f.p.state()).toEqual(before);
  } finally { f.close(); }
});


test("explicit recovery never replaces primary identity on server reset errors", async () => {
  const { recoverHeartbeatFamilies } = await import("./record-family-recovery.ts");
  const f=fixture([pagePayload([change("retained")]),pagePayload([],true)]);
  try {
    const before=await f.run(); f.setPageError("history_pruned");
    const r=await recoverHeartbeatFamilies({hours:12,workspaceId:"workspace",towerUrl:"https://tower.test",appNpub:"app",context:f.context,cacheRoot:f.cacheRoot},2);
    expect(r.outcome).toBe("blocked");
    expect(r.result.cache.clientId).toBe(before.cache.clientId);
    expect(r.result.cache.generation).toBe(before.cache.generation);
    expect(r.result.coverage.downloadedCounts.task).toBe(1);
    expect(r.result.errors.join(" ")).toContain("history_pruned");
  } finally { rmSync(f.cacheRoot,{recursive:true,force:true}); }
});

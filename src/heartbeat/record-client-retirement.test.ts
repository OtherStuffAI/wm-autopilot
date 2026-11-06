import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordSyncCache } from "./record-sync-cache.ts";
import { obsoleteRegistration } from "./record-client-retirement.ts";

test("retirement requires same cache, owner and retained obsolete generation", () => {
  const root = mkdtempSync(join(tmpdir(), "retire-client-"));
  const cache = new RecordSyncCache(join(root, "cache.sqlite"), ["tower", "workspace", "app", "bot"]);
  try {
    const old = cache.state();
    cache.db.query("INSERT INTO rows VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(old.generation, "task", "id", "1", "upsert", null, null, null, "", "{}", 1);
    const evidence = { botNpub: "bot", cache: { path: cache.path, clientId: old.clientId, generation: old.generation } };
    expect(() => obsoleteRegistration(cache, evidence)).toThrow("obsolete");
    cache.repair();
    expect(obsoleteRegistration(cache, evidence)).toBe(old.clientId);
    expect(() => obsoleteRegistration(cache, { ...evidence, botNpub: "other" })).toThrow("obsolete");
    expect(() => obsoleteRegistration(cache, { ...evidence, cache: { ...evidence.cache, path: "/other" } })).toThrow("obsolete");
    expect(() => obsoleteRegistration(cache, { ...evidence, cache: { ...evidence.cache, generation: "absent" } })).toThrow("retained downloads");
    expect(cache.db.query("SELECT count(*) AS n FROM rows").get()).toEqual({ n: 1 });
  } finally { cache.close(); rmSync(root, { recursive: true }); }
});

test("retirement checks reset before DELETE and preserves current cache", async () => {
  const { retireObsoleteRegistration } = await import("./record-client-retirement.ts");
  const root = mkdtempSync(join(tmpdir(), "retire-wire-"));
  const cache = new RecordSyncCache(join(root, "cache.sqlite"), ["https://tower", "workspace", "app", "bot"]);
  try {
    const old = cache.state();
    cache.db.query("INSERT INTO rows VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(old.generation, "task", "id", "1", "upsert", null, null, null, "", "{}", 1);
    const evidence = { botNpub: "bot", cache: { path: cache.path, clientId: old.clientId, generation: old.generation } };
    cache.repair();
    const state = cache.state();
    const methods: string[] = [];
    let reset = false;
    const context = { wingmanUrl: "https://broker", sessionId: "test", capabilityToken: "test", fetch: (async (input: any, init: any) => {
      if (new URL(String(input)).pathname.endsWith("/identity")) return Response.json({ identityType: "agent", botNpub: "bot" });
      const b = JSON.parse(init.body);
      if (b.action === "context") return Response.json({ workspace: { workspaceId: "workspace", backendBaseUrl: "https://tower", sourceAppNpub: "app" } });
      if (b.action === "transport_prepare") return Response.json({ url: b.url });
      if (String(input).endsWith("/nip98")) return Response.json({ token: "Nostr fixture" });
      methods.push(b.method);
      expect(b.url).toContain(`/clients/${b.url.includes(old.clientId) ? old.clientId : state.clientId}?protocol_version=2`);
      return Response.json({ status: b.method === "DELETE" ? 200 : reset ? 409 : 200, bodyBase64: Buffer.from(JSON.stringify(b.method === "DELETE" ? { protocol_version: 2, client_id: /clients\/([^?]+)/.exec(b.url)![1], retired: true } : reset ? { error: "reset_required" } : {})).toString("base64") });
    }) as typeof fetch };
    await expect(retireObsoleteRegistration(cache, evidence, context)).rejects.toThrow("refusing retirement");
    expect(methods).toEqual(["GET"]);
    reset = true;
    expect((await retireObsoleteRegistration(cache, evidence, context)).retired).toBe(true);
    expect(methods).toEqual(["GET", "GET", "DELETE"]);
    expect(cache.state()).toEqual(state);
    const failed = { botNpub: "bot", cache: { path: cache.path, clientId: state.clientId, generation: state.generation }, errors: ["Record-sync request failed (409): page_token_invalid"] };
    cache.db.query("INSERT INTO ack_intents VALUES(?,?,?,?, 'pending')").run(state.generation, state.clientId, "pending-cursor", "1");
    reset = false;
    const result = await retireObsoleteRegistration(cache, failed, context, true);
    expect(result.retired).toBe(true);
    expect(cache.state().clientId).toBe(state.clientId);
    expect(cache.state().generation).not.toBe(state.generation);
    expect(cache.state().cursor).toBeNull();
    expect(cache.pending()).toBeNull();
    expect(cache.db.query("SELECT status FROM ack_intents WHERE generation=?").get(state.generation)).toEqual({ status: "repair" });
    await expect(retireObsoleteRegistration(cache, failed, context, true)).rejects.toThrow("matching failed-wake evidence");
    expect(cache.db.query("SELECT state FROM registration_repairs").get()).toEqual({ state: JSON.stringify(state) });
    expect(cache.db.query("SELECT count(*) AS n FROM rows").get()).toEqual({ n: 1 });

  } finally { cache.close(); rmSync(root, { recursive: true }); }
});

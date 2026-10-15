import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSnapshot } from "../agents/process-manager";
import type { RequestAuthContext } from "../auth/request-context";
import { PromptQueueStore } from "../storage/prompt-queue-store";
import type { SessionApiContext } from "./session-api-routes";
import { handleQueueRoutes } from "./session-queue-routes";

test("reconciliation cannot invalidate a delivery that is still in flight", async () => {
  const root = mkdtempSync(join(tmpdir(), "queue-active-reconcile-"));
  try {
    const store = new PromptQueueStore(join(root, "queue.db"));
    const item = store.addPrompt("session", { content: "Possibly accepted work" })!;
    const claim = store.claimNextPrompt("session")!;
    store.markClaimSending("session", item.id, claim.claimToken!);
    const active = new Set(["session"]);
    const context = { promptQueueStore: store, queueDispatchInFlight: active } as unknown as SessionApiContext;
    const session = { id: "session", status: "running" } as SessionSnapshot;
    const auth = { capabilitySessionId: "session" } as RequestAuthContext;
    const parts = ["", "api", "sessions", "session", "queue", item.id, "reconcile"];
    const request = () => new Request(`http://localhost${parts.join("/")}`, {
      method: "POST",
      body: JSON.stringify({ revision: claim.revision, claimToken: claim.claimToken,
        resolution: "accepted", reason: "Acceptance confirmed independently" }),
      headers: { "content-type": "application/json" },
    });
    const blocked = await handleQueueRoutes(request(), "POST", parts, "session", session, auth, context);
    expect(blocked.status).toBe(409);
    expect(store.getSessionQueue("session")[0]?.claimToken).toBe(claim.claimToken);
    active.clear();
    const resolved = await handleQueueRoutes(request(), "POST", parts, "session", session, auth, context);
    expect(resolved.status).toBe(200);
    expect(store.getQueueCount("session")).toBe(0);
    expect(store.getHandledPrompts("session")[0]?.deliveryState).toBe("accepted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retention uses the latest dispatch after retry and accepts legacy timestamp formatting", () => {
  const root = mkdtempSync(join(tmpdir(), "queue-retry-retention-"));
  let inspect: Database | undefined;
  try {
    const path = join(root, "queue.db");
    const store = new PromptQueueStore(path);
    const item = store.addPrompt("session", { content: "Retried delivery" })!;
    const first = store.claimNextPrompt("session")!;
    store.reconcileClaim("session", item.id, first.revision, first.claimToken!, "retry", "actor", "Receiver confirmed rejection");
    inspect = new Database(path);
    inspect.query("UPDATE prompt_queue SET handled_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 3 * 86400000).toISOString(), item.id);
    const second = store.claimNextPrompt("session")!;
    store.completeClaim("session", item.id, second.claimToken!);
    const older = new Date(Date.now() - 86400000).toISOString();
    const insert = inspect.query(`INSERT INTO prompt_queue
      (id, session_id, content, timestamp, queue_order, state, handled_at)
      VALUES (?, 'session', 'Earlier work', ?, 1, 'handled', ?)`);
    inspect.transaction(() => {
      for (let index = 0; index < 1000; index++) insert.run(`older-${index}`, older, older);
    })();
    store.getHandledPrompts("session");
    expect(inspect.query("SELECT state FROM prompt_queue WHERE id = ?").get(item.id)).toEqual({ state: "dispatched" });
    inspect.query("DELETE FROM prompt_queue WHERE id != ?").run(item.id);
    const legacy = new Date(Date.now() - 7 * 86400000 + 60000).toISOString().replace("T", " ").slice(0, 19);
    inspect.query("UPDATE prompt_queue SET delivery_updated_at = ? WHERE id = ?").run(legacy, item.id);
    store.getHandledPrompts("session");
    expect(inspect.query("SELECT state FROM prompt_queue WHERE id = ?").get(item.id)).toEqual({ state: "dispatched" });
  } finally {
    inspect?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("retention keeps a newer dispatched receipt ahead of older handled records", () => {
  const root = mkdtempSync(join(tmpdir(), "queue-receipt-retention-"));
  const path = join(root, "queue.db");
  let inspect: Database | undefined;
  try {
    const store = new PromptQueueStore(path);
    const item = store.addPrompt("session", { content: "Latest delivery" })!;
    const claim = store.claimNextPrompt("session")!;
    store.completeClaim("session", item.id, claim.claimToken!);
    inspect = new Database(path);
    const older = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
    const insert = inspect.query(`INSERT INTO prompt_queue
      (id, session_id, content, timestamp, queue_order, state, handled_at)
      VALUES (?, 'session', 'Earlier work', ?, 1, 'handled', ?)`);
    inspect.transaction(() => {
      for (let index = 0; index < 1000; index++) insert.run(`older-${index}`, older, older);
    })();
    store.getHandledPrompts("session");
    expect(inspect.query("SELECT state FROM prompt_queue WHERE id = ?").get(item.id)).toEqual({ state: "dispatched" });
  } finally {
    inspect?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("consume shrinks pending during active work; inspection is inert and stale revisions conflict", async () => {
  const root = mkdtempSync(join(tmpdir(), "queue-consume-api-"));
  try {
    const store = new PromptQueueStore(join(root, "queue.db"));
    const item = store.addPrompt("session", { content: "New steering" })!;
    const next = store.addPrompt("session", { content: "Independent work" })!;
    const context = { promptQueueStore: store, queueDispatchInFlight: new Set() } as unknown as SessionApiContext;
    const session = { id: "session", status: "running", agentRuntimeStatus: "running" } as SessionSnapshot;
    const auth = { capabilitySessionId: "session" } as RequestAuthContext;
    const parts = ["", "api", "sessions", "session", "queue", item.id, "consume"];
    const request = (revision: string) => new Request(`http://localhost${parts.join("/")}`, {
      method: "POST", body: JSON.stringify({ revision, reason: "Incorporated steering into active work" }),
    });
    await handleQueueRoutes(new Request("http://localhost"), "GET", parts.slice(0, 5), "session", session, auth, context);
    expect(store.getQueueCount("session")).toBe(2);
    store.updatePromptContent("session", item.id, "Edited steering");
    expect((await handleQueueRoutes(request("1"), "POST", parts, "session", session, auth, context)).status).toBe(409);
    const response = await handleQueueRoutes(request("2"), "POST", parts, "session", session, auth, context);
    expect(response.status).toBe(200);
    expect((await response.json()).queue.prompts.map((p: { id: string }) => p.id)).toEqual([next.id]);
    expect(store.getHandledPrompts("session")[0]?.handledBy).toBe("session:session");
    expect((await handleQueueRoutes(request("2"), "POST", parts, "session", session, auth, context)).status).toBe(200);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

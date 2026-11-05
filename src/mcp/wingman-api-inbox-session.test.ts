import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import { createWingmanMcpApiHandler, type WingmanMcpApiDependencies } from "./wingman-api";
import { historyPage } from "../flightdeck-pg/__tests__/history-fixture.ts";
import { AgentInboxStore } from "../agent-chat/agent-inbox-store";
import { AgentInboxOriginStore, setAgentInboxOriginStoresForTests } from "../agent-chat/agent-inbox-origins";
import type { SessionSnapshot } from "../agents/process-manager";

// A strict-inbox subscription is a delivery profile: its session tools are the ordinary signed ones (Tower decides by ACL).
let dir = "";
let inbox: AgentInboxStore;
let origins: AgentInboxOriginStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-inbox-session-"));
  inbox = new AgentInboxStore(join(dir, "db.sqlite"));
  origins = new AgentInboxOriginStore(join(dir, "db.sqlite"));
  inbox.setMode("sub-inbox", "inbox_required", "c");
  inbox.update("sub-inbox", { towerSubscriptionId: "tower-sub", floorAt: "2026-11-02T00:00:00.000Z" });
  setAgentInboxOriginStoresForTests({ inbox, origins });
});
afterEach(() => {
  setAgentInboxOriginStoresForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

function handlerFor() {
  const botSecret = generateSecretKey();
  const botNpub = nip19.npubEncode(getPublicKey(botSecret));
  const session = {
    id: "direct-1", agent: "codex", port: 3700, name: "direct-1", status: "running", startedAt: new Date().toISOString(), command: [],
    workingDirectory: "/tmp", logs: [],
    metadata: { AGENT: true, sessionClass: "flightdeck_chat", flightdeckTowerServiceNpub: "npub-tower", flightdeckWorkspaceId: "workspace-1",
      flightdeckChannelId: "channel-1", flightdeckThreadId: "thread-1", flightdeckAgentNpub: botNpub, flightdeckRoutingKey: "agent-direct:route-1" },
  } as unknown as SessionSnapshot;
  const botIdentity = { botNpub, botPubkeyHex: getPublicKey(botSecret), botSecret };
  const deps = {
    getSession: (id: string) => (id === session.id ? session : null),
    listSessions: () => [session],
    resolveFlightDeckDirectContext: () => ({ subscriptionId: "sub-inbox", backendBaseUrl: "http://tower.test", appNpub: "npub-app", botIdentity }),
  } as unknown as WingmanMcpApiDependencies;
  const handler = createWingmanMcpApiHandler(deps);
  const url = new URL("http://localhost/api/mcp/wingman/flightdeck");
  return async (body: Record<string, unknown>) => (await handler(new Request(url, { method: "POST", body: JSON.stringify({ sessionId: "direct-1", ...body }) }), url, "POST"))!;
}

describe("strict-inbox session MCP helper", () => {
  test("reads and writes outside any notification reach Tower as ordinary bot requests", async () => {
    const call = handlerFor();
    const context = await call({ action: "context" });
    expect(await context.json()).toMatchObject({ agentInbox: { mode: "inbox_required" } });
    const requests: Request[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      if (request.url.includes("/tasks/task-foreign/")) return Response.json({ error: "Task unavailable", code: "task_unavailable" }, { status: 404 });
      return request.method === "POST" ? Response.json({ message: { id: "reply-1" }, comment: { id: "c-1" } }) : Response.json(historyPage(new URL(request.url)));
    }) as typeof fetch;
    try {
      const read = await call({ action: "thread_read", channelId: "channel-9", threadId: "thread-9" });
      expect(read.status).toBe(200);
      expect(await read.json()).not.toHaveProperty("bounded");
      const reply = await call({ action: "chat_reply", channelId: "channel-9", threadId: "thread-9", body: "out of trigger" });
      expect(reply.status).toBe(200);
      // A Tower ACL refusal is returned as Tower's refusal, not a local inbox code.
      const foreign = await call({ action: "task_comment", taskId: "task-foreign", body: "x" });
      expect(foreign.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(await foreign.json())).not.toContain("agent_inbox");
    } finally {
      globalThis.fetch = originalFetch;
    }
    const paths = requests.map((request) => `${request.method} ${new URL(request.url).pathname}`);
    expect(paths).toContain("GET /api/v4/flightdeck-pg/workspaces/workspace-1/channels/channel-9/messages");
    expect(paths).toContain("POST /api/v4/flightdeck-pg/workspaces/workspace-1/channels/channel-9/messages");
    const posted = await requests.find((request) => request.method === "POST" && request.url.includes("/channels/channel-9/messages"))!.clone().json();
    // No live origin covers channel-9: an ordinary write carries no origin provenance.
    expect(posted).toMatchObject({ thread_id: "thread-9", body: "out of trigger" });
    expect(posted).not.toHaveProperty("origin_notification_id");
    expect(requests.every((request) => request.headers.get("authorization")?.startsWith("Nostr "))).toBe(true);
  });

  test("record-sync and transport helpers are no longer refused locally for strict-inbox sessions", async () => {
    const call = handlerFor();
    for (const action of ["transport_request", "record_sync_request"]) {
      const body = await (await call({ action })).json() as { code?: string };
      // Reaches the ordinary transport handler (which validates its own input) instead of the removed inbox refusal.
      expect([action, body.code ?? null]).not.toEqual([action, "agent_inbox_unbound_action"]);
    }
  });
});

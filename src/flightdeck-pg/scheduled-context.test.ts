import { describe, expect, test } from "bun:test";
import { bindScheduledFlightDeckContext, type ScheduledContext } from "./scheduled-context.ts";

const config: ScheduledContext = {
  ownerNpub: "owner",
  subscriptionId: "10000000-0000-4000-8000-000000000001",
  workspaceId: "10000000-0000-4000-8000-000000000002",
  scopeId: "10000000-0000-4000-8000-000000000003",
  channelId: "10000000-0000-4000-8000-000000000004",
  threadId: "10000000-0000-4000-8000-000000000005",
  taskId: "10000000-0000-4000-8000-000000000006",
};

function fixture() {
  const session = { id: "self", npub: "owner", status: "running", agent: "codex",
    origin: { type: "scheduler", id: "job" }, workingDirectory: "/repo",
    metadata: { agentChatBotNpub: "bot" } as Record<string, unknown> };
  const job = { id: "job", enabled: true, actionType: "session", userNpub: "owner",
    botNpub: "bot", agent: "codex", workingDirectory: "/repo" };
  const subscription = { subscriptionId: config.subscriptionId, workspaceId: config.workspaceId,
    managedByNpub: "owner", botNpub: "bot", lifecycleStatus: "active", towerServiceNpub: "tower",
    backendConnectionId: "connection", backendBaseUrl: "https://tower.test", sourceAppNpub: "app" };
  const context = { workspace: { workspaceId: config.workspaceId, subscriptionId: config.subscriptionId,
    backendBaseUrl: subscription.backendBaseUrl, sourceAppNpub: "app" }, bot: { npub: "bot", available: true },
    chat: { channelId: config.channelId, threadId: config.threadId },
    routing: { bindingType: "task" }, record: { recordId: config.taskId } };
  const writes: unknown[] = [];
  return { session, job, subscription, context, writes, input: {
    sessionId: "self", config,
    request: async (method: string, path: string, body?: any) => {
      if (method === "PATCH") { writes.push(body); Object.assign(session.metadata, body.metadata); return {}; }
      if (path.endsWith("/scheduler/jobs")) return { jobs: [job] };
      if (path.includes("/subscriptions/")) return { subscription };
      if (path.endsWith("/metadata")) return { metadata: session.metadata };
      return session;
    },
    context: async () => context,
  } };
}

describe("scheduled Flight Deck binding", () => {
  test("binds the caller and verifies metadata and live context; repeat is idempotent", async () => {
    const f = fixture();
    expect(await bindScheduledFlightDeckContext(f.input)).toEqual(f.context);
    expect(f.session.metadata.flightdeckWorkspaceId).toBe(config.workspaceId);
    expect(f.session.metadata.bindingId).toBe(config.taskId);
    await bindScheduledFlightDeckContext(f.input);
    expect(f.writes).toHaveLength(2);
  });
  test.each(["owner", "origin", "trigger", "bot", "subscription", "inactive", "conflict"])(
    "rejects %s mismatch before changing metadata", async (condition) => {
      const f = fixture();
      if (condition === "owner") f.session.npub = "another";
      if (condition === "origin") f.session.origin.type = "session-dispatch";
      if (condition === "trigger") f.job.enabled = false;
      if (condition === "bot") f.job.botNpub = "another";
      if (condition === "subscription") f.subscription.workspaceId = config.scopeId;
      if (condition === "inactive") f.subscription.lifecycleStatus = "revoked";
      if (condition === "conflict") f.session.metadata.flightdeckThreadId = config.scopeId;
      await expect(bindScheduledFlightDeckContext(f.input)).rejects.toThrow();
      expect(f.writes).toHaveLength(0);
    },
  );
  test.each(["towerServiceNpub", "backendConnectionId", "backendBaseUrl", "sourceAppNpub"] as const)(
    "surfaces missing required %s before mutation", async (field) => {
      const f = fixture(); f.subscription[field] = "";
      await expect(bindScheduledFlightDeckContext(f.input)).rejects.toThrow("Tower service identity");
      expect(f.writes).toHaveLength(0);
    },
  );
  test("does not report success when live transport or metadata readback disagrees", async () => {
    const f = fixture(); f.context.workspace.backendBaseUrl = "https://wrong.test";
    await expect(bindScheduledFlightDeckContext(f.input)).rejects.toThrow("Live broker");
    const g = fixture(); const request = g.input.request;
    g.input.request = async (method, path, body) => path.endsWith("/metadata") && method === "GET"
      ? { metadata: {} } as any : request(method, path, body);
    await expect(bindScheduledFlightDeckContext(g.input)).rejects.toThrow("metadata readback");
  });
});

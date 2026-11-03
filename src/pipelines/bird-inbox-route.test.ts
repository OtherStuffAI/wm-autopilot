import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AgentInboxOriginStore, beginActiveInboxAttempt, recordInboxRunOrigin, setAgentInboxOriginStoresForTests } from "../agent-chat/agent-inbox-origins";
import { AgentInboxUnboundReadError, agentInboxScope } from "../agent-chat/agent-inbox-scope";
import { AgentInboxStore } from "../agent-chat/agent-inbox-store";
import { createFlightDeckThreadRuntime, inboxRunOriginChannel } from "./flightdeck-thread-runtime";

/**
 * Bird timeline chat on a strict-inbox (classified-ready) profile, with disposable stores only: the only Flight Deck
 * touchpoints are the bound invocation and the reply to the run's own origin thread.
 */
const definition = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "default-definitions", `${name}.json`), "utf8"));

describe("bird timeline chat Flight Deck touchpoints", () => {
  test("only the bound invocation and the origin-thread reply touch Flight Deck; retrieval makes no Tower call", () => {
    const chat = definition("bird.timeline.chat.v3");
    expect(chat.steps.map((step: any) => [step.type, step.block ?? step.function ?? step.pipeline ?? null])).toEqual([
      ["block", "flightdeck.threadInvocation"], ["pipeline", "bird.retrieve.v3"], ["code", "bird.format"], ["block", "flightdeck.returnToThread"],
    ]);
    const retrieve = definition("bird.retrieve.v3");
    const functions = retrieve.steps.map((step: any) => step.function).filter(Boolean);
    expect(functions).toEqual(["bird.resolveCli.v1", "bird.retrieveCli.v1"]);
    expect(JSON.stringify(retrieve)).not.toMatch(/flightdeck|tower|api\/v4/i);
  });
});

describe("bird timeline chat on a strict-inbox profile (disposable stores)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    setAgentInboxOriginStoresForTests(null);
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const invocation = { workspaceId: "ws-bird", threadId: "thread-bird", frmNpub: "npub1human", prompt: "@Piper bird timeline nostr" };
  const notification = { id: "n-bird", seq: 1, state: "active", kind: "chat_mention", occurred_at: "2026-11-03T01:00:00.000Z",
    source: { type: "message", id: "m-bird", version: 1, channel_id: "channel-bird", thread_id: "thread-bird", task_id: null, doc_id: null } };

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "bird-inbox-"));
    dirs.push(dir);
    const inbox = new AgentInboxStore(join(dir, "db.sqlite"));
    const origins = new AgentInboxOriginStore(join(dir, "db.sqlite"));
    setAgentInboxOriginStoresForTests({ inbox, origins });
    inbox.setMode("bird-sub", "inbox_required", "c");
    inbox.update("bird-sub", { towerSubscriptionId: "tower-sub", floorAt: "2026-11-02T00:00:00.000Z" });
    inbox.beginAttempt("bird-sub", notification.id, 1, notification as any);
    const towerReads: string[] = [];
    const sent: any[] = [];
    const runtime = createFlightDeckThreadRuntime({
      agentStore: { getByBotNpub: () => ({ agentId: "piper", managedByNpub: "npub1owner", enabled: true, archived: false, botNpub: "npub1piper" }) as never },
      subscriptionStore: { listAll: () => [{ workspaceId: invocation.workspaceId, subscriptionId: "bird-sub", backendBaseUrl: "https://tower.test",
        sourceAppNpub: "npub1app", botNpub: "npub1piper", lifecycleStatus: "active", managedByNpub: "npub1owner" } as never] },
      withAgentIdentity: async (_agent, operation) => await operation({ botNpub: "npub1piper" } as never),
      fetchScopes: async () => { towerReads.push("scopes"); return { scopes: [], next_cursor: null }; },
      fetchChannels: async () => { towerReads.push("channels"); return { channels: [], next_cursor: null }; },
      fetchMessages: async () => { towerReads.push("messages"); return { messages: [], next_cursor: null }; },
      createMessage: async (params: any) => { sent.push(params); return { message: { id: `reply-${sent.length}` } }; },
      inboxBinding: { isInboxSubscription: (id) => id === "bird-sub", runOriginChannel: inboxRunOriginChannel },
    });
    const scope = { notification: notification as any, profileNpub: "npub1piper", subscriptionId: "bird-sub", dispatch: true,
      context: { channel: { id: "channel-bird", scope_id: "scope-bird" }, trigger: { type: "message", message: { id: "m-bird", channel_id: "channel-bird", thread_id: "thread-bird" } } } as any };
    return { inbox, origins, runtime, towerReads, sent, scope };
  }

  test("invocation resolves from the notification, the run records it, and the reply goes only to its thread", async () => {
    const t = setup();
    const endAttempt = beginActiveInboxAttempt("bird-sub", notification.id);
    const resolved = await agentInboxScope.run(t.scope, async () => {
      const resolution = await t.runtime.resolve(invocation, "npub1owner", "npub1piper");
      recordInboxRunOrigin("run-bird"); // as the run service does when the run is created during dispatch
      return resolution;
    });
    expect(resolved).toMatchObject({ channelId: "channel-bird", scopeId: "scope-bird", threadId: "thread-bird", senderNpub: "npub1piper" });
    // Inline reply while the dispatch attempt still runs.
    await t.runtime.send({ ...invocation, channelId: "channel-bird", message: "Inline", pipelineRunId: "run-bird" });
    endAttempt();
    t.inbox.markHandled("bird-sub", notification.id, 1, "handled", null);
    // Asynchronous reply after the notification was handled.
    const delivered = await t.runtime.send({ ...invocation, channelId: "channel-bird", message: "Tweets", pipelineRunId: "run-bird" });
    expect(delivered).toMatchObject({ delivered: true, channelId: "channel-bird", threadId: "thread-bird" });
    expect(t.sent.map((params) => [params.channelId, params.threadId])).toEqual([["channel-bird", "thread-bird"], ["channel-bird", "thread-bird"]]);
    expect(t.towerReads).toEqual([]);
  });

  test("another run, another channel or a no-longer-live origin never receives a reply; nothing is scanned", async () => {
    const t = setup();
    await agentInboxScope.run(t.scope, async () => { recordInboxRunOrigin("run-bird"); });
    recordInboxRunOrigin("run-outside"); // created outside dispatch: no origin
    t.inbox.markHandled("bird-sub", notification.id, 1, "handled", null);
    for (const input of [
      { ...invocation, channelId: "channel-bird", message: "x", pipelineRunId: "run-outside" },
      { ...invocation, channelId: "channel-bird", message: "x" },
      { ...invocation, channelId: "channel-other", message: "x", pipelineRunId: "run-bird" },
      { ...invocation, threadId: "thread-other", channelId: "channel-bird", message: "x", pipelineRunId: "run-bird" },
    ]) {
      await expect(t.runtime.send(input)).rejects.toBeInstanceOf(AgentInboxUnboundReadError);
    }
    t.inbox.markHandled("bird-sub", notification.id, 1, "failed_permanent", null);
    await expect(t.runtime.send({ ...invocation, channelId: "channel-bird", message: "x", pipelineRunId: "run-bird" })).rejects.toBeInstanceOf(AgentInboxUnboundReadError);
    expect(t.sent).toEqual([]);
    expect(t.towerReads).toEqual([]);
  });
});

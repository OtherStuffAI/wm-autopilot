import { afterEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProcessManager, SessionSnapshot } from "../agents/process-manager";
import { AgentDirectDeliveryReconciler } from "./direct-chat-delivery-reconciler";
import { DirectChatTurnStore } from "./direct-chat-turn-store";
import { FlightDeckSessionTurnBridge } from "./flightdeck-session-turn-bridge";
import { FlightDeckSessionTurnStore } from "./flightdeck-session-turn-store";
import { buildDirectChatRoutingKey } from "./direct-chat-contract";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a callback final cannot overtake or replace a frozen Agent Direct human answer", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-direct-callback-overtake-"));
  roots.push(root);
  const path = join(root, "turns.sqlite");
  const directTurns = new DirectChatTurnStore(path);
  const callbackTurns = new FlightDeckSessionTurnStore(path);
  const session = {
    id: "session-1", agent: "codex", status: "running", port: 3700, name: "Agent Direct",
    startedAt: "2026-10-19T12:20:00.000Z", command: ["codex"], workingDirectory: "/tmp/agent",
    logs: [], agentRuntimeStatus: "stable", metadata: {
      sessionClass: "flightdeck_chat", agentTransport: "codex-sdk",
      agentChatAgentId: "agent-1",
      flightdeckSubscriptionId: "subscription-1", flightdeckTowerServiceNpub: "npub1tower",
      flightdeckWorkspaceId: "workspace-1", flightdeckChannelId: "channel-1",
      flightdeckThreadId: "thread-1", flightdeckAgentNpub: "npub1agent",
    },
  } as SessionSnapshot;
  const messages = [
    { role: "user", content: "human prompt human-1 human-2", createdAt: "2026-10-19T12:28:30.234Z" },
    { role: "assistant", content: "Correct human answer", createdAt: "2026-10-19T12:48:43.116Z" },
  ];
  const manager = {
    getSession: (id: string) => id === session.id ? session : undefined,
    getAdapter: (id: string) => id === session.id ? {
      deliversPromptsDirectly: () => true,
      fetchMessages: async () => [...messages],
      fetchStatus: async () => "stable" as const,
    } : null,
    captureAgentapiCodexSessionIdFromPrompt: mock(async () => false),
  } as unknown as ProcessManager;
  const publications: Array<Record<string, any>> = [];
  let directPublishEntered!: () => void;
  let releaseDirectPublish!: () => void;
  const directPublishStarted = new Promise<void>((resolve) => { directPublishEntered = resolve; });
  const directPublishGate = new Promise<void>((resolve) => { releaseDirectPublish = resolve; });
  const publish = mock(async (input: Record<string, any>) => {
    if (input.metadata.prompt_type === "direct_chat") {
      directPublishEntered();
      await directPublishGate;
    }
    publications.push(input);
    return { message: { id: `message-${publications.length}` } };
  });
  const now = "2026-10-19T12:28:30.234Z";
  const routingKey = buildDirectChatRoutingKey({ towerServiceNpub: "npub1tower", workspaceId: "workspace-1",
    channelId: "channel-1", threadId: "thread-1", agentNpub: "npub1agent" });
  session.metadata!.flightdeckRoutingKey = routingKey;
  directTurns.save({ turnId: "human-turn", routingKey, sourceMessageIds: ["human-1", "human-2"],
    clientRequestId: "agentdirect:route:human-turn", replyBody: null, publishedMessageId: null,
    state: "awaiting_reply", createdAt: now, updatedAt: now, subscriptionId: "subscription-1",
    backendBaseUrl: "https://tower.test", towerServiceNpub: "npub1tower", workspaceId: "workspace-1",
    sourceAppNpub: "npub1app", channelId: "channel-1", threadId: "thread-1", agentId: "agent-1",
    agentNpub: "npub1agent", sessionId: session.id, prompt: "human prompt human-1 human-2",
    promptType: "direct_chat", acceptedAt: now, nextAttemptAt: now });
  const reconciler = new AgentDirectDeliveryReconciler({ manager, store: directTurns, instanceId: "test",
    resolveTransport: () => ({ backendBaseUrl: "https://tower.test", workspaceId: "workspace-1", appNpub: "npub1app" }),
    withProfileIdentity: async (_record, operation) => operation({ botNpub: "npub1agent", botPubkeyHex: "00", botSecret: new Uint8Array([1]) }),
    publish: publish as never });
  const bridge = new FlightDeckSessionTurnBridge({ manager,
    store: callbackTurns,
    resolveDelivery: () => ({ subscriptionId: "subscription-1", backendBaseUrl: "https://tower.test",
      appNpub: "npub1app", botIdentity: { botNpub: "npub1agent", botPubkeyHex: "00", botSecret: new Uint8Array([1]) } }),
    publish: publish as never });

  const humanPublication = reconciler.processTurnNow("human-turn");
  await directPublishStarted;
  expect(directTurns.get("human-turn")?.publicationPayload).toMatchObject({
    body: "Correct human answer",
    metadata: { prompt_type: "direct_chat", source_message_ids: ["human-1", "human-2"] },
  });

  messages.push(
    { role: "user", content: "internal callback wake", createdAt: "2026-10-19T12:48:47.753Z" },
    { role: "assistant", content: "Callback review final", createdAt: "2026-10-19T12:53:26.713Z" },
  );
  const callback = bridge.accept({ session, prompt: "internal callback wake", promptType: "dispatch_inbox_wake",
    boundaryIdentity: "callback-1", acceptedAt: "2026-10-19T12:48:47.753Z" })!;
  await bridge.publishKnownFinal(callback, "Callback review final", "2026-10-19T12:53:26.713Z");
  releaseDirectPublish();
  await humanPublication;
  await reconciler.processTurnNow("human-turn");

  expect(publications).toHaveLength(2);
  expect(publications.filter((entry) => entry.metadata.prompt_type === "dispatch_inbox_wake")).toHaveLength(1);
  expect(publications.filter((entry) => entry.metadata.prompt_type === "direct_chat")).toEqual([
    expect.objectContaining({ body: "Correct human answer", metadata: expect.objectContaining({
      source_message_ids: ["human-1", "human-2"],
    }) }),
  ]);
  expect(publications.some((entry) => entry.metadata.prompt_type === "direct_chat" && entry.body === "Callback review final")).toBeFalse();
});

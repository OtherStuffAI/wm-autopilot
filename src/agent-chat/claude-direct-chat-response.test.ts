import { expect, test } from "bun:test";
import type { AgentAdapter } from "../agents/agent-adapter";
import type { ProcessManager, SessionSnapshot } from "../agents/process-manager";
import { inspectAcceptedFinalResponse, sendPromptAndAwaitFinalResponse } from "./direct-chat-response";

test("Claude SDK reports live activity and accepts only the terminal answer", async () => {
  const prompt = "Inspect the project";
  const session = { id: "claude-stream", agent: "claude", status: "running",
    metadata: { agentTransport: "claude-sdk" } } as SessionSnapshot;
  let sent = false;
  let completed = false;
  let livePolls = 0;
  let receipts = 0;
  const adapter = {
    deliversPromptsDirectly: () => true,
    getPromptReadiness: async () => ({ state: "ready", reason: "ready", retryAfterMs: 1, observedAt: Date.now() }),
    sendMessage: async () => {
      sent = true;
      await new Promise((resolve) => setTimeout(resolve, 60));
      completed = true;
    },
    fetchStatus: async () => completed ? "stable" : "running",
    fetchMessages: async () => sent ? [
      { role: "user", content: prompt, createdAt: "2026-10-08T00:00:00Z" },
      { role: "agent-thinking", content: "Inspecting instructions", createdAt: "2026-10-08T00:00:01Z" },
      { role: "agent-tools", content: "Tool result: Read (completed)", createdAt: "2026-10-08T00:00:02Z" },
      { role: completed ? "assistant" : "agent-working", content: completed ? "**Final answer**" : "Partial answer", createdAt: "2026-10-08T00:00:03Z" },
    ] : [],
  } as unknown as AgentAdapter;
  const manager = { getSession: () => session, getAdapter: () => adapter } as unknown as ProcessManager;
  const reply = await sendPromptAndAwaitFinalResponse(manager, session.id, prompt, {
    timeoutMs: 300, pollIntervalMs: 5,
    onAccepted: () => { receipts += 1; },
    onPoll: () => { if (sent && !completed) livePolls += 1; },
  });
  expect(livePolls).toBeGreaterThan(0);
  expect(receipts).toBe(1);
  expect(reply.content).toBe("**Final answer**");
  const recovered = await inspectAcceptedFinalResponse(manager, session.id, prompt, []);
  expect(recovered.reply?.content).toBe(reply.content);
});

test("Claude recovery rejects a streaming assistant snapshot while busy", async () => {
  const session = { id: "claude-recover", agent: "claude", status: "running",
    metadata: { agentTransport: "claude-sdk" } } as SessionSnapshot;
  const adapter = {
    deliversPromptsDirectly: () => true,
    fetchStatus: async () => "running",
    fetchMessages: async () => [
      { role: "user", content: "Question", createdAt: "2026-10-08T00:00:00Z" },
      { role: "assistant", content: "Incomplete", createdAt: "2026-10-08T00:00:01Z" },
    ],
  } as unknown as AgentAdapter;
  const manager = { getSession: () => session, getAdapter: () => adapter } as unknown as ProcessManager;
  expect((await inspectAcceptedFinalResponse(manager, session.id, "Question", [])).reply).toBeNull();
});

test("Claude crash recovery rejects persisted nonterminal text after readiness", async () => {
  const session = { id: "claude-crash", agent: "claude", status: "running",
    metadata: { agentTransport: "claude-sdk" } } as SessionSnapshot;
  const adapter = {
    deliversPromptsDirectly: () => true,
    fetchStatus: async () => "stable",
    fetchMessages: async () => [
      { role: "user", content: "Question", createdAt: "2026-10-08T00:00:00Z" },
      { role: "agent-streaming", content: "Unfinished answer", createdAt: "2026-10-08T00:00:01Z" },
    ],
  } as unknown as AgentAdapter;
  const manager = { getSession: () => session, getAdapter: () => adapter } as unknown as ProcessManager;
  const inspection = await inspectAcceptedFinalResponse(manager, session.id, "Question", []);
  expect(inspection.runtimeStable).toBe(true);
  expect(inspection.reply).toBeNull();
});

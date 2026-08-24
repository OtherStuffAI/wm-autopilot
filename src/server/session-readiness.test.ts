import { describe, expect, test } from "bun:test";

import type { AgentAdapter } from "../agents/agent-adapter";
import type { SessionSnapshot } from "../agents/process-manager";
import { waitForSessionPromptReadiness } from "./session-readiness";

describe("waitForSessionPromptReadiness", () => {
  test("uses the faster default poll interval while preserving stable poll semantics", async () => {
    const session: SessionSnapshot = {
      id: "session-1",
      agent: "codex",
      port: 0,
      name: "Prompt Ready Session",
      status: "running",
      agentRuntimeStatus: "stable",
      startedAt: new Date().toISOString(),
      command: [],
      workingDirectory: "/tmp",
      logs: [],
      metadata: { AGENT: true, billingMode: "subscription" },
    };

    const adapter: AgentAdapter = {
      async fetchStatus() {
        return "stable";
      },
      async sendMessage() {},
      async fetchMessages() {
        return [];
      },
      async interruptCurrentTurn() {
        return false;
      },
      getEventsUrl() {
        return null;
      },
      async waitForReady() {},
      async dispose() {},
    };

    const startedAt = Date.now();
    await waitForSessionPromptReadiness({
      getSession: () => session,
      getAdapter: () => adapter,
      sessionId: session.id,
      host: "127.0.0.1",
      timeoutMs: 2_000,
      requiredStablePolls: 3,
      requestTimeoutMs: 25,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(450);
    expect(elapsedMs).toBeLessThan(900);
  });

  test("does not trust a stable session snapshot when adapter readiness is busy", async () => {
    const session: SessionSnapshot = {
      id: "session-2",
      agent: "codex",
      port: 0,
      name: "Prompt Ready Session",
      status: "running",
      agentRuntimeStatus: "stable",
      startedAt: new Date().toISOString(),
      command: [],
      workingDirectory: "/tmp",
      logs: [],
      metadata: { AGENT: true, billingMode: "subscription" },
    };

    const adapter: AgentAdapter = {
      async getPromptReadiness() {
        return {
          state: "busy",
          reason: "test-active-turn",
          retryAfterMs: 25,
          observedAt: Date.now(),
        };
      },
      async fetchStatus() {
        return "stable";
      },
      async sendMessage() {},
      async fetchMessages() {
        return [];
      },
      async interruptCurrentTurn() {
        return false;
      },
      getEventsUrl() {
        return null;
      },
      async waitForReady() {},
      async dispose() {},
    };

    await expect(
      waitForSessionPromptReadiness({
        getSession: () => session,
        getAdapter: () => adapter,
        sessionId: session.id,
        host: "127.0.0.1",
        timeoutMs: 100,
        pollIntervalMs: 25,
        requiredStablePolls: 1,
        requestTimeoutMs: 25,
      }),
    ).rejects.toThrow("test-active-turn");
  });

  test("uses a short default status request timeout when the snapshot is not stable yet", async () => {
    const session: SessionSnapshot = {
      id: "session-3",
      agent: "codex",
      port: 0,
      name: "Prompt Ready Session",
      status: "running",
      agentRuntimeStatus: "running",
      startedAt: new Date().toISOString(),
      command: [],
      workingDirectory: "/tmp",
      logs: [],
      metadata: { AGENT: true, billingMode: "subscription" },
    };

    const requestTimeouts: number[] = [];
    const adapter: AgentAdapter = {
      async fetchStatus(timeoutMs) {
        requestTimeouts.push(timeoutMs ?? 0);
        return "stable";
      },
      async sendMessage() {},
      async fetchMessages() {
        return [];
      },
      async interruptCurrentTurn() {
        return false;
      },
      getEventsUrl() {
        return null;
      },
      async waitForReady() {},
      async dispose() {},
    };

    await waitForSessionPromptReadiness({
      getSession: () => session,
      getAdapter: () => adapter,
      sessionId: session.id,
      host: "127.0.0.1",
      timeoutMs: 2_000,
      requiredStablePolls: 1,
    });

    expect(requestTimeouts).toEqual([750]);
  });
});

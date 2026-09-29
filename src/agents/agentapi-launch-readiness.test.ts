import { describe, expect, test } from "bun:test";
import { waitForAgentApiLaunchReady } from "./agentapi-launch-readiness";
import type { AgentAdapter } from "./agent-adapter";

describe("AgentAPI launch readiness", () => {
  test("waits for the endpoint before allowing session creation to finish", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let finished = false;
    let checks = 0;
    const adapter = {
      waitForReady: () => pending,
      getPromptReadiness: async () => {
        checks += 1;
        return { state: "ready", reason: "stable", observedAt: Date.now() };
      },
    } as unknown as AgentAdapter;
    const ready = waitForAgentApiLaunchReady(adapter, 3700, []).then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    release();
    await ready;
    expect(finished).toBe(true);
    expect(checks).toBe(1);
  });

  test("keeps a newly started AgentAPI session behind the gate while it is busy", async () => {
    let checks = 0;
    const adapter = {
      waitForReady: async () => {},
      getPromptReadiness: async () => {
        checks += 1;
        return checks === 1
          ? { state: "busy", reason: "agentapi-status-running", retryAfterMs: 1, observedAt: Date.now() }
          : { state: "ready", reason: "agentapi-status-stable", observedAt: Date.now() };
      },
    } as unknown as AgentAdapter;
    await waitForAgentApiLaunchReady(adapter, 3700, []);
    expect(checks).toBe(2);
  });

  test("reports the startup stderr when the endpoint never becomes ready", async () => {
    const adapter = {
      waitForReady: async () => { throw new Error("Timed out waiting for codex agent to become ready"); },
      getPromptReadiness: async () => ({ state: "unreachable", reason: "unreachable", observedAt: Date.now() }),
    } as unknown as AgentAdapter;
    await expect(waitForAgentApiLaunchReady(adapter, 3701, ["[stderr] codex: command not found"]))
      .rejects.toThrow("AgentAPI failed to become ready on port 3701: Timed out waiting for codex agent to become ready; [stderr] codex: command not found");
  });
});

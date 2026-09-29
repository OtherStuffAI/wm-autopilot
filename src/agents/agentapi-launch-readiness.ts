import type { AgentAdapter } from "./agent-adapter";

export async function waitForAgentApiLaunchReady(
  adapter: AgentAdapter,
  port: number,
  logs: string[],
): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastReason = "AgentAPI status unavailable";
  try {
    const getPromptReadiness = adapter.getPromptReadiness;
    if (!getPromptReadiness) throw new Error("AgentAPI adapter does not expose prompt readiness");
    await adapter.waitForReady({ timeoutMs: 30_000 });
    while (Date.now() < deadline) {
      const readiness = await getPromptReadiness.call(adapter, Math.min(1000, deadline - Date.now()));
      if (readiness.state === "ready") return;
      lastReason = readiness.reason;
      await Bun.sleep(Math.min(readiness.retryAfterMs ?? 250, 500, Math.max(0, deadline - Date.now())));
    }
    throw new Error(`timed out waiting for prompt readiness (${lastReason})`);
  } catch (error) {
    const stderr = logs.findLast((entry) => entry.startsWith("[stderr]"));
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`AgentAPI failed to become ready on port ${port}: ${reason}${stderr ? `; ${stderr}` : ""}`);
  }
}

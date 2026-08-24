import type { AgentAdapter, PromptReadiness } from "../agents/agent-adapter";
import type { SessionSnapshot } from "../agents/process-manager";
import { getSessionPromptReadiness } from "./prompt-readiness";

export interface WaitForSessionPromptReadinessOptions {
  getSession: (sessionId: string) => SessionSnapshot | null;
  getAdapter: (sessionId: string) => AgentAdapter | null;
  sessionId: string;
  host: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  requiredStablePolls?: number;
  requestTimeoutMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const DEFAULT_STATUS_REQUEST_TIMEOUT_MS = 750;

export async function waitForSessionPromptReadiness(
  options: WaitForSessionPromptReadinessOptions,
): Promise<void> {
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 60000;
  const pollIntervalMs = options.pollIntervalMs && options.pollIntervalMs > 0 ? options.pollIntervalMs : 250;
  const requiredStablePolls =
    options.requiredStablePolls && options.requiredStablePolls > 0 ? options.requiredStablePolls : 3;
  const requestTimeoutMs =
    options.requestTimeoutMs && options.requestTimeoutMs > 0
      ? options.requestTimeoutMs
      : DEFAULT_STATUS_REQUEST_TIMEOUT_MS;

  const deadline = Date.now() + timeoutMs;
  let readyPolls = 0;
  let lastReadiness: PromptReadiness | null = null;

  while (Date.now() < deadline) {
    const session = options.getSession(options.sessionId);
    const adapter = options.getAdapter(options.sessionId);
    const readiness = await getSessionPromptReadiness({
      session,
      adapter,
      timeoutMs: requestTimeoutMs,
    });
    lastReadiness = readiness;

    if (readiness.state === "ready") {
      readyPolls += 1;
      if (readyPolls >= requiredStablePolls) {
        return;
      }
    } else {
      readyPolls = 0;
    }

    await sleep(Math.max(pollIntervalMs, readiness.retryAfterMs));
  }

  const reason = lastReadiness ? ` last readiness: ${lastReadiness.state} (${lastReadiness.reason})` : "";
  throw new Error(`Timed out waiting for session ${options.sessionId} to become prompt-ready.${reason}`);
}

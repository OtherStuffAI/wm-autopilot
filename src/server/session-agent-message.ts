import type { AgentAdapter } from "../agents/agent-adapter";
import { waitForAgentReady } from "../agents/agent-client";
import { getProcessByName, restartProcess } from "../agents/pm2-wrapper";
import type { AgentType } from "../config";

export interface SessionAgentMessageInput {
  sessionId?: string;
  agentHost: string;
  buildAgentUrl: (host: string, port: number, path: string) => string | URL;
  agent: AgentType;
  port: number;
  content: string;
  type: "user" | "raw";
  pm2Name?: string;
  adapter?: AgentAdapter | null;
}

export interface SessionAgentMessageResult {
  ok: boolean;
  status: number;
  message: string;
}

const RECOVERABLE_STATUS_CODES = new Set([404, 408, 429, 500, 502, 503, 504]);
const TRANSIENT_RETRY_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const REQUEST_TIMEOUT_MS = 15000;
const MAX_TRANSIENT_ATTEMPTS = 3;
const TRANSIENT_RETRY_BASE_DELAY_MS = 350;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const parseErrorMessage = async (response: Response): Promise<string> => {
  const errorPayload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const payloadMessage = errorPayload && typeof errorPayload.error === "string" ? errorPayload.error : null;
  return payloadMessage ?? response.statusText ?? "Agent request failed";
};

async function postMessage(input: SessionAgentMessageInput): Promise<Response> {
  const agentUrl = input.buildAgentUrl(input.agentHost, input.port, "/message");
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(agentUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: input.type, content: input.content }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

const shouldAttemptPm2Recovery = (statusCode: number, pm2Name?: string): boolean => {
  return Boolean(pm2Name && RECOVERABLE_STATUS_CODES.has(statusCode));
};

async function recoverPm2Session(input: SessionAgentMessageInput): Promise<boolean> {
  const pm2Name = input.pm2Name;
  if (!pm2Name) {
    return false;
  }

  const processInfo = await getProcessByName(pm2Name).catch(() => null);
  if (!processInfo) {
    return false;
  }

  const status = processInfo.pm2_env?.status;
  if (status !== "online") {
    await restartProcess(pm2Name);
  }

  await waitForAgentReady(input.agentHost, input.port, input.agent, {
    timeoutMs: 8000,
    pollIntervalMs: 250,
  });

  return true;
}

async function tryWithTransientRetries(input: SessionAgentMessageInput): Promise<SessionAgentMessageResult> {
  let lastStatus = 502;
  let lastMessage = "Agent request failed";

  for (let attempt = 1; attempt <= MAX_TRANSIENT_ATTEMPTS; attempt += 1) {
    try {
      const response = await postMessage(input);
      if (response.ok) {
        return { ok: true, status: response.status, message: "" };
      }

      const message = await parseErrorMessage(response);
      lastStatus = response.status;
      lastMessage = message;

      if (TRANSIENT_RETRY_STATUS_CODES.has(response.status) && attempt < MAX_TRANSIENT_ATTEMPTS) {
        await sleep(TRANSIENT_RETRY_BASE_DELAY_MS * attempt);
        continue;
      }

      return { ok: false, status: response.status, message };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastStatus = 502;
      lastMessage = `Failed to contact agent: ${message}`;
      if (attempt < MAX_TRANSIENT_ATTEMPTS) {
        await sleep(TRANSIENT_RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
      return { ok: false, status: lastStatus, message: lastMessage };
    }
  }

  return { ok: false, status: lastStatus, message: lastMessage };
}

export async function deliverSessionAgentMessage(
  input: SessionAgentMessageInput,
): Promise<SessionAgentMessageResult> {
  // In-process native SDK adapters (Pi, native Codex) bypass agentapi entirely
  // and must receive prompts through the adapter rather than an HTTP POST.
  if (input.type !== "raw" && input.adapter?.deliversPromptsDirectly?.()) {
    try {
      const readiness = await input.adapter.getPromptReadiness?.(250);
      if (readiness?.state === "busy" || readiness?.state === "starting") {
        return { ok: false, status: 409, message: "Agent working" };
      }
      await input.adapter.waitForReady({
        timeoutMs: 8000,
        pollIntervalMs: 100,
      });
      await input.adapter.sendMessage(input.content, input.type);
      return { ok: true, status: 200, message: "" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("still processing a prompt")) {
        return { ok: false, status: 409, message: "Agent working" };
      }
      return { ok: false, status: 502, message: `Failed to contact agent: ${message}` };
    }
  }

  if (input.adapter) {
    try {
      await input.adapter.waitForReady({
        timeoutMs: 8000,
        pollIntervalMs: 250,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, status: 502, message: `Failed to contact agent: ${message}` };
    }
  }

  const initialResult = await tryWithTransientRetries(input);
  if (initialResult.ok || !shouldAttemptPm2Recovery(initialResult.status, input.pm2Name)) {
    return initialResult;
  }

  const recovered = await recoverPm2Session(input).catch(() => false);
  if (!recovered) {
    return initialResult;
  }

  return tryWithTransientRetries(input);
}

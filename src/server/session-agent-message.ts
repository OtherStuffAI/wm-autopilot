import { submitAdapterPrompt } from "../agents/prompt-submission";
import type { AgentAdapter } from "../agents/agent-adapter";
import type { AgentType } from "../config";

export interface SessionAgentMessageInput {
  sessionId?: string;
  beforeSend?: () => boolean;
  onSending?: () => void;
  deliveryId?: string;
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
  certainty: "unsent" | "rejected" | "uncertain" | "accepted";
  ok: boolean;
  status: number;
  message: string;
}

const REQUEST_TIMEOUT_MS = 15000;

const parseErrorMessage = async (response: Response): Promise<string> => {
  const errorPayload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const payloadMessage = errorPayload && typeof errorPayload.error === "string" ? errorPayload.error : null;
  return payloadMessage ?? response.statusText ?? "Agent request failed";
};

async function postMessage(input: SessionAgentMessageInput, agentUrl: string | URL): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(agentUrl, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json" },
      // AgentAPI's strict message schema accepts only type and content. The
      // delivery ID belongs to Autopilot's durable claim, not this transport.
      body: JSON.stringify({ type: input.type, content: input.content }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function submitOnce(input: SessionAgentMessageInput): Promise<SessionAgentMessageResult> {
  let sending = false;
  try {
    if (input.beforeSend && !input.beforeSend()) return { ok: false, status: 409, message: "Delivery claim is no longer current", certainty: "unsent" };
    // URL construction failures occur before the durable send boundary.
    const url = input.buildAgentUrl(input.agentHost, input.port, "/message");
    new URL(url);
    input.onSending?.();
    sending = true;
    const response = await postMessage(input, url);
    if (response.ok) return { ok: true, status: response.status, message: "", certainty: "accepted" };
    // Only explicit client rejection proves nonacceptance; server failures may follow acceptance.
    const certainty = response.status >= 400 && response.status < 500 && response.status !== 408 ? "rejected" : "uncertain";
    return { ok: false, status: response.status, message: await parseErrorMessage(response), certainty };
  } catch (error) {
    return { ok: false, status: 502, message: String(error), certainty: sending ? "uncertain" : "unsent" };
  }
}

export async function deliverSessionAgentMessage(
  input: SessionAgentMessageInput,
): Promise<SessionAgentMessageResult> {
  // In-process native SDK adapters (Pi, native Codex) bypass agentapi entirely
  // and must receive prompts through the adapter rather than an HTTP POST.
  if (input.type !== "raw" && input.adapter?.deliversPromptsDirectly?.()) {
    let sending = false;
    try {
      const readiness = await input.adapter.getPromptReadiness?.(250);
      if (readiness?.state === "busy" || readiness?.state === "starting") {
        return { ok: false, status: 409, message: "Agent working", certainty: "rejected" };
      }
      await input.adapter.waitForReady({
        timeoutMs: 8000,
        pollIntervalMs: 100,
      });
      if (input.beforeSend && !input.beforeSend()) return { ok: false, status: 409, message: "Delivery claim is no longer current", certainty: "unsent" };
      input.onSending?.();
      sending = true;
      await submitAdapterPrompt(input.adapter, input.content, input.type);
      return { ok: true, status: 200, message: "", certainty: "accepted" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("still processing a prompt")) {
        return { ok: false, status: 409, message: "Agent working", certainty: sending ? "uncertain" : "rejected" };
      }
      return { ok: false, status: 502, message: `Failed to contact agent: ${message}`, certainty: sending ? "uncertain" : "unsent" };
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
      return { ok: false, status: 502, message: `Failed to contact agent: ${message}`, certainty: "unsent" };
    }
  }

  return submitOnce(input);
}

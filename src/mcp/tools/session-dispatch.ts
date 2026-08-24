import { z } from "zod";
import { AGENT_TYPES } from "../../agent-types";

export const sessionDispatchSchema = {
  action: z.enum(["create", "status", "list", "inbox", "acknowledge", "close", "retry"]).default("create"),
  dispatchId: z.string().optional(),
  agent: z.enum(AGENT_TYPES).optional(),
  directory: z.string().optional(),
  name: z.string().optional(),
  prompt: z.string().optional(),
  reportingContext: z.record(z.string(), z.unknown()).optional(),
};

export const sessionDispatchDescription =
  "Dispatch supervised work to another Autopilot session. Terminal results remain durable in this exact session's callback inbox; use action=inbox to review them, then acknowledge and close handled callbacks. Also inspect or retry a dispatch. Reporting context is optional.";

export async function handleSessionDispatch(params: Record<string, unknown>, wingmanUrl: string, sessionId: string) {
  const action = String(params.action ?? "create");
  const headers = { "content-type": "application/json", "x-wingman-session-id": sessionId };
  let path = "/api/session-dispatches";
  let method = "GET";
  let body: string | undefined;
  if (action === "create") {
    method = "POST";
    body = JSON.stringify({ agent: params.agent, directory: params.directory, name: params.name,
      prompt: params.prompt, reportingContext: params.reportingContext,
      callback: { enabled: true, sessionId } });
  } else if (action === "inbox") {
    path += "/inbox";
  } else if (action !== "list") {
    if (!params.dispatchId) return { isError: true, content: [{ type: "text" as const, text: "dispatchId is required" }] };
    path += `/${encodeURIComponent(String(params.dispatchId))}`;
    if (action !== "status") { method = "POST"; path += `/${action === "retry" ? "retry-callback" : action}`; }
  }
  try {
    const response = await fetch(`${wingmanUrl}${path}`, { method, headers, body });
    const text = await response.text();
    return { isError: !response.ok, content: [{ type: "text" as const, text: response.ok ? text : `Dispatch failed (${response.status}): ${text}` }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text" as const, text: `Dispatch request failed: ${(error as Error).message}` }] };
  }
}

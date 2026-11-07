import { nip19 } from "nostr-tools";
import { capabilityClientContextFromEnv } from "../../src/mcp/capability-client";
import { createBotIdentityFromCapability } from "../../src/flightdeck-pg/client";
import { buildFlightDeckPgMessageInstructionSignatureForIdentity } from "../../src/agent-chat/tower-client";
import type { PrivateReportContext, PrivateReportRequest } from "../../src/flightdeck-pg/private-report";

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Tower returned an empty private-report response.");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 10 * 1024 * 1024) throw new Error("Tower private-report response exceeded its byte budget; coverage is incomplete.");
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel(); }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tower returned invalid private-report JSON.");
  return value;
}

export function privateReportRequest(context: PrivateReportContext): PrivateReportRequest {
  const decoded = nip19.decode(context.bot.npub);
  if (decoded.type !== "npub") throw new Error("Exact broker bot npub is required.");
  const identity = createBotIdentityFromCapability({ ...capabilityClientContextFromEnv(), botNpub: context.bot.npub, botPubkeyHex: decoded.data });
  const deadline = Date.now() + 120_000;
  let requests = 0;
  return async (method, path, body) => {
    if (++requests > 200 || Date.now() >= deadline) throw new Error("Private report request budget exhausted; coverage is incomplete.");
    const url = new URL(path, context.workspace.backendBaseUrl);
    const prefix = `/api/v4/flightdeck-pg/workspaces/${context.workspace.workspaceId}/`;
    if (url.origin !== new URL(context.workspace.backendBaseUrl).origin || !url.pathname.startsWith(prefix) || !["https:", "http:"].includes(url.protocol) || url.hostname.endsWith(".fips")) {
      throw new Error("Private report requires its exact bound workspace and selected Tower HTTP transport; no fallback is permitted.");
    }
    const messageMatch = url.pathname.match(/\/channels\/([^/]+)\/messages$/);
    if (method === "POST" && messageMatch) {
      const message = body as { body: string; create_thread: boolean; client_request_id: string };
      body = { ...message, message_signature: await buildFlightDeckPgMessageInstructionSignatureForIdentity({
        botIdentity: identity, body: message.body, workspaceId: context.workspace.workspaceId, channelId: messageMatch[1]!,
      }) };
    }
    const authorization = await identity.signNip98({ url: url.toString(), method, body });
    const response = await fetch(url, { method, redirect: "error", headers: { authorization,
      "x-flightdeck-pg-app-npub": context.workspace.sourceAppNpub,
      ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - Date.now()))) });
    const value = await boundedJson(response);
    if (!response.ok) throw privateReportResponseError(method, url.pathname, response.status, value);
    return value;
  };
}

/** Never include response prose, body text, query values or signatures in diagnostics. */
export function privateReportResponseError(method: string, path: string, status: number, value: Record<string, unknown>) {
  const token = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_.-]{1,160}$/.test(value) ? value : "unknown";
  const details = value.details as { fields?: unknown } | undefined;
  const fields = Array.isArray(details?.fields) ? details.fields.slice(0, 20).map(field => {
    const item = field as { path?: unknown; code?: unknown } | null;
    return `${token(item?.path)}:${token(item?.code)}`;
  }).join(", ") : "";
  return new Error(`Tower private report ${method} ${path} failed (${status}): ${token(value.code)}${fields ? `; fields: ${fields}` : ""}`);
}

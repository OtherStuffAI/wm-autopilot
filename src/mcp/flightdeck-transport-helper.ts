import { readBoundedBody, DecodedResponseTooLarge } from "../heartbeat/bounded-response.ts";
import { permitsRecordSyncTransport } from "./record-sync-transport-policy.ts";
import { readTowerResponseBytes } from "./tower-response-bytes";
import { createHash } from "node:crypto";
import { verifyEvent } from "nostr-tools";
import { fetchTowerRequest, prepareTowerRequestUrl } from "../agent-chat/tower-transport-runtime";

export async function handleFlightDeckTransport(input: {
  action: string; body: Record<string, unknown>; subscriptionId: string; workspaceId: string; botPubkeyHex: string; appNpub?: string; signal?: AbortSignal;
}, dependencies = { prepare: prepareTowerRequestUrl, fetch: fetchTowerRequest }): Promise<Response> {
  const context = { subscriptionId: input.subscriptionId };
  const url = new URL(String(input.body.url));
  if (url.pathname.endsWith("/events/stream") || new Headers(input.body.headers as [string, string][] | undefined).get("accept")?.includes("text/event-stream")) {
    return Response.json({ error: "Host CLI transport supports finite responses only" }, { status: 400 });
  }
  const method = String(input.body.method || "GET");
  const bounded = input.action === "record_sync_request" || input.body.recordSync === true;
  if (bounded && !permitsRecordSyncTransport(url, method, input.workspaceId)) return Response.json({ error: "Invalid bounded record-sync target" }, { status: 403 });
  const signal = bounded ? AbortSignal.any([AbortSignal.timeout(30_000), ...(input.signal ? [input.signal] : [])]) : input.signal;
  const target = await dependencies.prepare(url, context, signal);
  const workspacePrefix = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(input.workspaceId)}`;
  if (!(url.pathname === workspacePrefix || url.pathname.startsWith(`${workspacePrefix}/`) || url.pathname.startsWith("/api/v4/storage/") || (bounded && url.pathname === "/api/v4/flightdeck-pg/service"))) {
    return Response.json({ error: "Tower request is outside the bound workspace/storage routes" }, { status: 403 });
  }
  if (input.action === "transport_prepare") return Response.json({ url: target });
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error("Unsupported Tower transport method");
  const headers = new Headers(input.body.headers as [string, string][]);
  const auth = headers.get("authorization") || "";
  const event = JSON.parse(Buffer.from(auth.replace(/^Nostr\s+/i, ""), "base64").toString());
  if (typeof input.body.bodyBase64 === "string" && input.body.bodyBase64.length > Math.ceil(32 * 1024 * 1024 / 3) * 4) {
    throw new Error("Tower broker request exceeds 32 MiB");
  }
  const bytes = input.body.bodyBase64 == null ? undefined : Buffer.from(String(input.body.bodyBase64), "base64");
  if (bounded) {
    if (!input.appNpub || headers.get("x-flightdeck-pg-app-npub") !== input.appNpub) return Response.json({ error: "Bound record-sync app identity is required" }, { status: 403 });
    if ((bytes?.byteLength ?? 0) > 16_384) return Response.json({ error: "Record-sync command body exceeds limit" }, { status: 413 });
    if (method === "GET" && bytes !== undefined) return Response.json({ error: "Record-sync GET cannot have a body" }, { status: 400 });
    if (method === "POST" && !url.pathname.endsWith("/ack") && (bytes?.byteLength ?? 0) !== 0) return Response.json({ error: "Registration requires empty body" }, { status: 400 });
    if (method === "POST" && url.pathname.endsWith("/ack")) {
      let intent: Record<string, unknown>;
      try { intent = JSON.parse(bytes?.toString() ?? ""); } catch { return Response.json({ error: "Invalid acknowledgement body" }, { status: 400 }); }
      if (!intent || Array.isArray(intent) || Object.keys(intent).sort().join() !== "cursor,expected_revision" || typeof intent.cursor !== "string" || !intent.cursor || !/^(0|[1-9][0-9]*)$/.test(String(intent.expected_revision)) || typeof intent.expected_revision !== "string") return Response.json({ error: "Invalid acknowledgement body" }, { status: 400 });
    }
  }
  const tag = (name: string) => event.tags.find((item: string[]) => item[0] === name)?.[1];
  if (!verifyEvent(event) || event.kind !== 27235 || event.pubkey !== input.botPubkeyHex || Math.abs(Date.now() / 1000 - event.created_at) > 60
    || tag("u") !== target || tag("method") !== method
    || (bounded && method === "POST" && !tag("payload"))
    || ((bytes !== undefined || tag("payload") !== undefined) && tag("payload") !== createHash("sha256").update(bytes ?? Buffer.alloc(0)).digest("hex"))) {
    return Response.json({ error: "Tower authorization does not match bound actor and exact request" }, { status: 403 });
  }
  if ((bytes?.byteLength ?? 0) > 32 * 1024 * 1024) throw new Error("Tower broker request exceeds 32 MiB");
  if ((headers.has("host") && headers.get("host") !== new URL(target).host)
    || [...headers.keys()].some((key) => key === "forwarded" || key.startsWith("x-forwarded-"))) {
    return Response.json({ error: "Tower forwarding headers cannot override the approved target" }, { status: 403 });
  }
  const transportStarted = performance.now();
  const response = await dependencies.fetch(url, { method, headers, body: bytes, signal }, context);
  const headersReceived = performance.now();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    await response.body?.cancel();
    throw new Error("Host CLI transport rejected a streaming response");
  }
  if (input.action === "record_sync_request") {
    let body: Uint8Array;
    try { body = await readBoundedBody(response, signal ?? AbortSignal.timeout(30_000)); }
    catch (error) {
      if (error instanceof DecodedResponseTooLarge) return Response.json({ error: "record_response_too_large" }, { status: 413 });
      throw error;
    }
    return new Response(body, { status: response.status, headers: { "content-type": "application/json", "x-wingman-record-headers-ms": String(headersReceived - transportStarted), "x-wingman-record-body-ms": String(performance.now() - headersReceived), ...(response.headers.has("retry-after") ? { "retry-after": response.headers.get("retry-after")! } : {}) } });
  }
  const body = await readTowerResponseBytes(response);
  return Response.json({ status: response.status, headers: [...response.headers], bodyBase64: body?.toString("base64") ?? null });
}

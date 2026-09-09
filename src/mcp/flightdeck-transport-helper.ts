import { readTowerResponseBytes } from "./tower-response-bytes";
import { createHash } from "node:crypto";
import { verifyEvent } from "nostr-tools";
import { fetchTowerRequest, prepareTowerRequestUrl } from "../agent-chat/tower-transport-runtime";

export async function handleFlightDeckTransport(input: {
  action: string; body: Record<string, unknown>; subscriptionId: string; workspaceId: string; botPubkeyHex: string; signal?: AbortSignal;
}): Promise<Response> {
  const context = { subscriptionId: input.subscriptionId };
  const url = new URL(String(input.body.url));
  if (url.pathname.endsWith("/events/stream") || new Headers(input.body.headers as [string, string][] | undefined).get("accept")?.includes("text/event-stream")) {
    return Response.json({ error: "Host CLI transport supports finite responses only" }, { status: 400 });
  }
  const target = await prepareTowerRequestUrl(url, context);
  const workspacePrefix = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(input.workspaceId)}`;
  if (!(url.pathname === workspacePrefix || url.pathname.startsWith(`${workspacePrefix}/`) || url.pathname.startsWith("/api/v4/storage/"))) {
    return Response.json({ error: "Tower request is outside the bound workspace/storage routes" }, { status: 403 });
  }
  if (input.action === "transport_prepare") return Response.json({ url: target });
  const method = String(input.body.method || "GET");
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error("Unsupported Tower transport method");
  const headers = new Headers(input.body.headers as [string, string][]);
  const auth = headers.get("authorization") || "";
  const event = JSON.parse(Buffer.from(auth.replace(/^Nostr\s+/i, ""), "base64").toString());
  if (typeof input.body.bodyBase64 === "string" && input.body.bodyBase64.length > Math.ceil(32 * 1024 * 1024 / 3) * 4) {
    throw new Error("Tower broker request exceeds 32 MiB");
  }
  const bytes = input.body.bodyBase64 == null ? undefined : Buffer.from(String(input.body.bodyBase64), "base64");
  const tag = (name: string) => event.tags.find((item: string[]) => item[0] === name)?.[1];
  if (!verifyEvent(event) || event.kind !== 27235 || event.pubkey !== input.botPubkeyHex || Math.abs(Date.now() / 1000 - event.created_at) > 60
    || tag("u") !== target || tag("method") !== method
    || ((bytes !== undefined || tag("payload") !== undefined) && tag("payload") !== createHash("sha256").update(bytes ?? Buffer.alloc(0)).digest("hex"))) {
    return Response.json({ error: "Tower authorization does not match bound actor and exact request" }, { status: 403 });
  }
  if ((bytes?.byteLength ?? 0) > 32 * 1024 * 1024) throw new Error("Tower broker request exceeds 32 MiB");
  if ((headers.has("host") && headers.get("host") !== new URL(target).host)
    || [...headers.keys()].some((key) => key === "forwarded" || key.startsWith("x-forwarded-"))) {
    return Response.json({ error: "Tower forwarding headers cannot override the approved target" }, { status: 403 });
  }
  const response = await fetchTowerRequest(url, { method, headers, body: bytes, signal: input.signal }, context);
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    await response.body?.cancel();
    throw new Error("Host CLI transport rejected a streaming response");
  }
  const body = await readTowerResponseBytes(response);
  return Response.json({ status: response.status, headers: [...response.headers], bodyBase64: body?.toString("base64") ?? null });
}

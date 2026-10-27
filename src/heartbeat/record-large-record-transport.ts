import type { RecordSyncClient } from "./record-sync-client.ts";
import { permitsRecordSyncTransport } from "../mcp/record-sync-transport-policy.ts";
import { validRecordSyncAcknowledgement } from "../mcp/record-sync-ack-policy.ts";

export type LargeRecordTransport = "bounded" | "host-finite";
/** Explicit use of the existing finite host capability, never a retry fallback.
 * Same selected host transport, signer and workspace; local protocol limits
 * remain narrower than that capability's general-purpose response ceiling.
 */
export async function finiteLargeRecordResponse(
  client: RecordSyncClient, url: string, method: "GET" | "POST",
  headers: Record<string, string>, body: string | undefined,
): Promise<Response> {
  const target = new URL(url);
  const match = /^\/api\/v4\/flightdeck-pg\/workspaces\/([^/]+)\/record-sync\//.exec(target.pathname);
  const chunk = /\/chunks\/(0|[1-9][0-9]*)$/.test(target.pathname);
  if (!match || !permitsRecordSyncTransport(target, method, decodeURIComponent(match[1]!)) ||
    (method === "GET" ? !chunk || body !== undefined : !target.pathname.endsWith("/ack") || !validRecordSyncAcknowledgement(JSON.parse(body ?? "null"))))
    throw new Error("Invalid explicit large-record transport target/body");
  const result = await client.broker<{ status: number; headers: [string, string][]; bodyBase64: string | null }>(
    "/api/mcp/wingman/flightdeck", { action: "transport_request", url, method, headers: Object.entries(headers),
      bodyBase64: body === undefined ? null : Buffer.from(body).toString("base64") });
  const limit = chunk && result.status >= 200 && result.status < 300 ? 262_144 : 1_048_576;
  if (typeof result.bodyBase64 !== "string" || result.bodyBase64.length > 4 * Math.ceil(limit / 3))
    throw new Error("Finite host response exceeds large-record wire bound");
  const bytes = Buffer.from(result.bodyBase64, "base64");
  if (bytes.length > limit) throw new Error("Finite host decoded response exceeds wire bound");
  return new Response(bytes, { status: result.status, headers: result.headers });
}

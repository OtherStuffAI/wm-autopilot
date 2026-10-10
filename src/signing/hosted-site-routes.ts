import type { RequestAuthContext } from "../auth/request-context";
import { SecretError } from "../secrets/secret-policy";
import { SignerError } from "./application-signer";
import type { HostedSiteSigner, HostedSiteGrant, HostedSiteRequest } from "./hosted-site-signer";

function response(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
async function body(request: Request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "")) throw new SignerError("invalid_request");
  if (Number(request.headers.get("content-length")) > 16384) throw new SignerError("payload_denied");
  const reader = request.body?.getReader();
  if (!reader) throw new SignerError("invalid_request");
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 16384) { await reader.cancel(); throw new SignerError("payload_denied"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SignerError("invalid_request");
  return value;
}
function failed(error: unknown) {
  return response({ error: error instanceof SignerError || error instanceof SecretError ? error.code : "hosted_site_signer_failed" }, 403);
}
/** Runtime ingress is mounted behind the existing actual-loopback guard. */
export async function handleHostedSiteRuntime(request: Request, url: URL, signer: HostedSiteSigner): Promise<Response> {
  try {
    if (request.method !== "POST" || url.search) return response({ error: "method_denied" }, 405);
    const credential = request.headers.get("authorization")?.match(/^Bearer (wmhost_v1_[A-Za-z0-9_-]{43})$/)?.[1] ?? "";
    const input = await body(request);
    if (url.pathname === "/api/internal/signing/hosted-site/readiness") return response(await signer.readiness(credential, input.appId, input.url, input.siteNpub));
    if (url.pathname === "/api/internal/signing/hosted-site/attest") return response({ event: await signer.attest(credential, input as HostedSiteRequest) });
    return response({ error: "not_found" }, 404);
  } catch (error) { return failed(error); }
}
/** Owner management shares the protected import UI/API authority, never agent delegation. */
export async function handleHostedSiteManagement(request: Request, url: URL, auth: RequestAuthContext, signer: HostedSiteSigner): Promise<Response | null> {
  const base = "/api/secrets/hosted-site-grants";
  if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return null;
  const owner = auth.npub;
  if (!owner || auth.delegatedByBot || auth.delegatedOwnerNpub || auth.capabilitySessionId
    || (auth.actorNpub && auth.actorNpub !== owner)) return response({ error: "secret_management_denied" }, 403);
  try {
    if (url.pathname === base && request.method === "GET") return response({ grants: signer.list(owner, url.searchParams.get("workspace") ?? "local") });
    if (url.pathname === base && request.method === "POST") {
      const input = await body(request) as Omit<HostedSiteGrant, "id" | "ownerNpub" | "appRoot">;
      return response(await signer.registerManaged(owner, input), 201);
    }
    const parts = url.pathname.slice(base.length + 1).split("/");
    if (parts.length === 1 && request.method === "DELETE") { signer.revoke(owner, parts[0]!); return response({ revoked: true }); }
    if (parts.length === 2 && parts[1] === "audit" && request.method === "GET") return response({ audit: signer.history(owner, parts[0]!) });
    return response({ error: "not_found" }, 404);
  } catch (error) { return failed(error); }
}

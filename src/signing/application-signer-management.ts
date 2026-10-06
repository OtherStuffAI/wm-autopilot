import { ApplicationSigner, SignerError, type ApplicationGrantPolicy } from "./application-signer";
import { BROKER_KEY_IDENTITY_MISMATCH, BROKER_KEY_NOT_PROVISIONED } from "./broker-key-vault";

/** Called only after the normal SystemManage authorization gate. */
export async function handleApplicationSignerManagement(request: Request, url: URL, actor: string, signer: ApplicationSigner): Promise<Response | null> {
  const base = "/api/admin/signing-policies/applications";
  if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return null;
  try {
    if (request.method === "POST" && url.pathname === base) {
      if (Number(request.headers.get("content-length") ?? 0) > 65536) return Response.json({ error: "payload_too_large" }, { status: 413 });
      const bodyText = await request.text();
      if (Buffer.byteLength(bodyText) > 65536) return Response.json({ error: "payload_too_large" }, { status: 413 });
      const body = JSON.parse(bodyText) as { botNpub: string; expectedPubkey: string; policy: ApplicationGrantPolicy };
      const result = await signer.registerVerified(actor, body.botNpub, body.expectedPubkey, body.policy);
      return Response.json(result, { status: 201, headers: { "cache-control": "no-store" } });
    }
    if (request.method === "DELETE" && url.pathname.startsWith(`${base}/`)) {
      signer.revoke(actor, decodeURIComponent(url.pathname.slice(base.length + 1)));
      return Response.json({ revoked: true });
    }
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  } catch (error) {
    const vaultCode = (error as { code?: unknown } | null)?.code;
    const code = error instanceof SignerError ? error.code
      : vaultCode === BROKER_KEY_NOT_PROVISIONED || vaultCode === BROKER_KEY_IDENTITY_MISMATCH ? vaultCode : "application_grant_invalid";
    return Response.json({ error: code }, { status: 400 });
  }
}

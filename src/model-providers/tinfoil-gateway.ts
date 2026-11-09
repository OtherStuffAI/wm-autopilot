import { randomBytes, createHash } from "node:crypto";
import type { SecretStore, ProviderConnection } from "../secrets/secret-store";
import { assertSecretUse, SecretError, type SecretConsumer } from "../secrets/secret-policy";

type LiveSession = { npub?: string; status: string; model?: string; metadata?: { modelProvider?: string; modelProviderWorkspaceId?: string; flightdeckWorkspaceId?: string; agentChatBotNpub?: string; agentChatAgentId?: string } };
interface Grant {
  sessionId: string; consumer: SecretConsumer; connection: ProviderConnection; model: string; expiresAt: number; profileId: string; secretRevision: number;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const failure = (error: string, status: number) => Response.json({ error: { message: error, type: "provider_error" } }, { status, headers: { "cache-control": "no-store" } });

export class TinfoilGateway {
  private readonly grants = new Map<string, Grant>();
  private server: ReturnType<typeof Bun.serve> | null = null;
  constructor(private readonly store: SecretStore, private readonly getSession: (id: string) => LiveSession | null,
    private readonly proxyBaseUrl: () => Promise<string>, private readonly fetchImpl: typeof fetch = fetch) {}
  issue(sessionId: string, consumer: SecretConsumer, model: string): { baseUrl: string; token: string } {
    const connection = this.store.providerConnection(consumer.ownerNpub, consumer.workspaceId);
    if (!connection?.enabled || !connection.models.includes(model)) throw new SecretError("tinfoil_model_not_configured", 403);
    const secret = this.store.get(consumer.ownerNpub, consumer.workspaceId, connection.credentialRef);
    assertSecretUse(secret, consumer);
    const live = this.getSession(sessionId);
    if (!live?.metadata?.agentChatAgentId || live.metadata.agentChatBotNpub !== consumer.identityNpub) throw new SecretError("tinfoil_identity_binding_required", 403);
    this.revoke(sessionId);
    const token = randomBytes(32).toString("base64url");
    this.grants.set(digest(token), { sessionId, consumer: { ...consumer }, connection, model, profileId: live.metadata.agentChatAgentId, secretRevision: secret.revision, expiresAt: Date.now() + 12 * 60 * 60 * 1000 });
    if (!this.server) this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, maxRequestBodySize: 8 * 1024 * 1024,
      fetch: request => this.handle(request) });
    return { baseUrl: `http://127.0.0.1:${this.server.port}/v1`, token };
  }
  revoke(sessionId: string): void { for (const [key, grant] of this.grants) if (grant.sessionId === sessionId) this.grants.delete(key); }
  private check(grant: Grant): void {
    if (![...this.grants.values()].includes(grant)) throw new SecretError("tinfoil_grant_revoked", 403);
    const session = this.getSession(grant.sessionId);
    const connection = this.store.providerConnection(grant.consumer.ownerNpub, grant.consumer.workspaceId);
    if (grant.expiresAt <= Date.now() || !session || session.status !== "running" || session.npub !== grant.consumer.ownerNpub
      || session.metadata?.agentChatBotNpub !== grant.consumer.identityNpub || session.metadata.agentChatAgentId !== grant.profileId
      || session.metadata?.modelProvider !== "tinfoil" || session.metadata.modelProviderWorkspaceId !== grant.consumer.workspaceId
      || (session.metadata.flightdeckWorkspaceId && session.metadata.flightdeckWorkspaceId !== grant.consumer.workspaceId)
      || ![grant.model, `tinfoil/${grant.model}`].includes(session.model ?? "")
      || !connection?.enabled || connection.revision !== grant.connection.revision) throw new SecretError("tinfoil_session_denied", 403);
    const secret = this.store.get(grant.consumer.ownerNpub, grant.consumer.workspaceId, grant.connection.credentialRef);
    if (secret.revision !== grant.secretRevision) throw new SecretError("tinfoil_credential_changed", 403);
    assertSecretUse(secret, grant.consumer);
  }
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.has("origin")) return failure("browser_inference_denied", 403);
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const grant = token ? this.grants.get(digest(token)) : undefined;
    if (!grant) return failure("invalid_session_credential", 401);
    try { this.check(grant); } catch { return failure("tinfoil_session_denied", 403); }
    if (!url.search && url.pathname === "/v1/models" && request.method === "GET") return Response.json({ object: "list", data: [{ id: grant.model, object: "model", owned_by: "tinfoil" }] }, { headers: { "cache-control": "no-store" } });
    if (url.search || url.pathname !== "/v1/chat/completions" || request.method !== "POST") return failure("tinfoil_endpoint_denied", 404);
    let body;
    try {
      const raw = await request.text();
      if (Buffer.byteLength(raw) > 8 * 1024 * 1024) return failure("request_too_large", 413);
      body = JSON.parse(raw);
      if (!body || body.model !== grant.model || !Array.isArray(body.messages)) return failure("tinfoil_model_denied", 403);
    } catch { return failure("invalid_inference_request", 400); }
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const timer = setTimeout(abort, 10 * 60_000);
    const policyTimer = setInterval(() => { try { this.check(grant); } catch { abort(); } }, 500);
    const cleanup = () => { clearTimeout(timer); clearInterval(policyTimer); request.signal.removeEventListener("abort", abort); };
    try {
      const base = await this.proxyBaseUrl();
      this.check(grant);
      const upstream = await this.store.withServiceCredential(grant.connection.credentialRef, grant.consumer, value => this.fetchImpl(`${base}/chat/completions`, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { authorization: `Bearer ${value}`, "content-type": "application/json" }, body: JSON.stringify(body),
      }));
      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel(); cleanup();
        return failure("tinfoil_upstream_rejected", upstream.status === 429 ? 429 : 502);
      }
      const contentType = upstream.headers.get("content-type") ?? "";
      if (!(body.stream ? contentType.includes("text/event-stream") : contentType.includes("application/json"))) {
        await upstream.body.cancel(); cleanup(); return failure("tinfoil_invalid_response", 502);
      }
      const reader = upstream.body.getReader();
      const stream = new ReadableStream<Uint8Array>({
        pull: async target => {
          try {
            this.check(grant);
            const next = await reader.read();
            this.check(grant);
            if (next.done) { cleanup(); reader.releaseLock(); target.close(); }
            else target.enqueue(next.value);
          } catch { abort(); cleanup(); await reader.cancel().catch(() => {}); target.error(new Error("tinfoil_stream_ended")); }
        },
        cancel: async () => { abort(); cleanup(); await reader.cancel().catch(() => {}); },
      });
      return new Response(stream, { headers: { "content-type": contentType, "cache-control": "no-store", "x-accel-buffering": "no" } });
    } catch { abort(); cleanup(); return failure(controller.signal.aborted ? "tinfoil_request_cancelled" : "tinfoil_connection_failed", 502); }
  }
  close(): void { this.grants.clear(); this.server?.stop(true); this.server = null; }
}

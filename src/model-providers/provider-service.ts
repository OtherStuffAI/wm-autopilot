import type { SecretStore } from "../secrets/secret-store";
import { TinfoilProxy } from "./tinfoil-proxy";
import { TinfoilGateway } from "./tinfoil-gateway";
import { assertSecretUse, SecretError, validatedNpub } from "../secrets/secret-policy";

export function createModelProviderService(store: SecretStore, getSession: ConstructorParameters<typeof TinfoilGateway>[1]) {
  const proxy = new TinfoilProxy();
  const gateway = new TinfoilGateway(store, getSession, () => proxy.baseUrl());
  return {
    gateway,
    async test(owner: string, workspace: string, identity: string) {
      validatedNpub(identity);
      const connection = store.providerConnection(owner, workspace);
      if (!connection?.enabled) throw new SecretError("provider_not_configured", 403);
      const consumer = { ownerNpub: owner, workspaceId: workspace, identityNpub: identity, context: "session" as const, contextId: identity };
      assertSecretUse(store.get(owner, workspace, connection.credentialRef), consumer);
      let base: string;
      try { base = await proxy.baseUrl(); } catch { throw new SecretError("tinfoil_verified_proxy_unavailable", 503); }
      return store.withServiceCredential(connection.credentialRef, consumer, async value => {
        const response = await fetch(`${base}/chat/completions`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
          headers: { authorization: `Bearer ${value}`, "content-type": "application/json" },
          body: JSON.stringify({ model: connection.models[0], messages: [{ role: "user", content: "Call the connection_check tool with ok true." }],
            tools: [{ type: "function", function: { name: "connection_check", description: "Confirm this connection", parameters: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } } }],
            tool_choice: "required", max_tokens: 1024 }),
        });
        if (!response.ok) { await response.body?.cancel(); throw new SecretError("tinfoil_test_rejected", 502); }
        const body = await response.json() as { choices?: Array<{ message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }> };
        const call = body.choices?.[0]?.message?.tool_calls?.find(item => item.function?.name === "connection_check");
        if (!call?.function?.arguments || JSON.parse(call.function.arguments).ok !== true) throw new SecretError("tinfoil_tool_check_failed", 502);
        return { connected: true, toolCalling: true, model: connection.models[0], verifiedProxy: true };
      });
    },
    close() { gateway.close(); proxy.close(); },
  };
}

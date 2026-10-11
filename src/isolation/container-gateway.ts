import { ProviderPolicyError, PROVIDER_LIMITS, validateProviderRequest, validateProviderReply } from "./provider-policy.ts";
import type { ProviderReply } from "./provider-policy.ts";

export function startContainerGateway(model: string) {
  let requests = 0;
  const pending = new Map<number, (reply: ProviderReply | null) => void>();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    maxRequestBodySize: PROVIDER_LIMITS.requestBytes,
    async fetch(request) {
      const url = new URL(request.url);
      const id = ++requests;
      if (request.method !== "POST" || url.pathname !== "/v1/responses" || url.search || id > PROVIDER_LIMITS.requests) {
        return new Response("Capability denied", { status: 403 });
      }
      try {
        const body = validateProviderRequest(await request.json(), model);
        const response = new Promise<ProviderReply | null>((resolve) => pending.set(id, resolve));
        console.log(JSON.stringify({ type: "provider", id, body }));
        const reply = await response;
        if (!reply) return new Response("Model capability unavailable", { status: 502 });
        validateProviderReply(reply);
        return new Response(reply.body, { headers: { "content-type": reply.contentType } });
      } catch (error) {
        return new Response(error instanceof ProviderPolicyError ? error.message : "Invalid model capability payload", { status: 403 });
      }
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    receive(frame: { id: number; reply: ProviderReply | null }) {
      const resolve = pending.get(frame.id);
      if (!resolve) throw new Error("Unexpected model reply");
      pending.delete(frame.id);
      resolve(frame.reply);
    },
    stop() { server.stop(true); },
  };
}

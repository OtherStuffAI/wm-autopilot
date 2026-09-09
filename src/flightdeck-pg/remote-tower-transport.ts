import { callCapabilityBroker, type CapabilityClientContext } from "../mcp/capability-client";

export interface RemoteTowerTransport {
  prepare: (url: string) => Promise<string>;
  fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
}

export function remoteTowerTransport(context: () => CapabilityClientContext): RemoteTowerTransport {
  const call = (action: string, input: Record<string, unknown>, signal?: AbortSignal | null) => callCapabilityBroker<Record<string, unknown>>(
    "/api/mcp/wingman/flightdeck", { action, ...input }, (() => {
      const current = context();
      const fetchImpl = current.fetch ?? globalThis.fetch;
      return { ...current, fetch: Object.assign((url: Parameters<typeof fetch>[0], init?: RequestInit) => fetchImpl(url, { ...init, signal }), fetchImpl) };
    })(),
  );
  return {
    prepare: async (url) => {
      const response = await call("transport_prepare", { url });
      if (typeof response.url !== "string") throw new Error("Host omitted the approved Tower request target");
      return response.url;
    },
    fetch: async (url, init = {}) => {
      init.signal?.throwIfAborted();
      const bytes = init.body == null ? null : new Uint8Array(await new Response(init.body).arrayBuffer());
      const response = await call("transport_request", { url: url.toString(), method: init.method ?? "GET",
        headers: [...new Headers(init.headers)], bodyBase64: bytes === null ? null : Buffer.from(bytes).toString("base64") }, init.signal);
      init.signal?.throwIfAborted();
      return new Response(response.bodyBase64 == null ? null : Buffer.from(String(response.bodyBase64), "base64"), {
        status: Number(response.status), headers: response.headers as [string, string][],
      });
    },
  };
}

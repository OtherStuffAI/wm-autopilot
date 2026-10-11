import type { ProjectProvider, ProviderReply } from "./provider-policy.ts";
import { PROVIDER_LIMITS } from "./provider-policy.ts";

/** Credentials are supplied explicitly by the authorized control plane; never serialized to workers. */
export function createResponsesProvider(model: string, apiKey: string): ProjectProvider {
  if (!model || !apiKey) throw new Error("An authorized model and provider credential are required");
  return {
    model,
    async responses(body, signal): Promise<ProviderReply> {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST", redirect: "error", signal,
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok || !response.body) throw new Error(`Model provider failed (${response.status})`);
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > PROVIDER_LIMITS.responseBytes) {
          await response.body.cancel().catch(() => undefined);
          throw new Error("Model reply byte limit exceeded");
        }
        chunks.push(chunk);
      }
      const contentType = response.headers.get("content-type")?.split(";")[0];
      if (contentType !== "text/event-stream" && contentType !== "application/json") throw new Error("Invalid model reply type");
      return { body: Buffer.concat(chunks).toString("utf8"), contentType };
    },
  };
}

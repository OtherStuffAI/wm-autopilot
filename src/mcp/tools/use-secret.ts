import { z } from "zod";
import { callCapabilityBroker } from "../capability-client";

export const useSecretSchema = {
  credentialRef: z.string().uuid().describe("Opaque owner-provided imported credential reference"),
  operation: z.enum(["sign", "return"]).describe("Sign without exporting, or explicitly permitted retrieval. Returned values can enter session history and cannot be recalled."),
  event: z.object({ kind: z.number().int(), content: z.string(), tags: z.array(z.array(z.string())), created_at: z.number().int().optional() }).optional(),
};
export const useSecretDescription = "Use an imported owner credential under its identity and session policy. Caller/session/agent/workspace are bound by the server. Signing-only keys cannot be returned. No publishing occurs.";
export async function handleUseSecret(params: { credentialRef: string; operation: "sign" | "return"; event?: unknown }, wingmanUrl: string, sessionId: string) {
  try {
    const result = await callCapabilityBroker("/api/mcp/capabilities/secrets", params, {
      wingmanUrl, sessionId, capabilityToken: process.env.WINGMAN_CAPABILITY ?? "",
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text" as const, text: `Credential use denied: ${(error as Error).message}` }] };
  }
}

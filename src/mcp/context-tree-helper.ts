import { FlightDeckPgClient, createBotIdentityFromCapability } from "../flightdeck-pg/client.ts";
import { contextOperations, executeContextOperation, type ContextOperation } from "../flightdeck-pg/context-operations.ts";
import { FlightDeckPgResponseError } from "../flightdeck-pg/response-error.ts";
import type { FlightDeckPgBotIdentity } from "../agent-chat/tower-client.ts";
import { ZodError } from "zod";

export async function handleContextTreeHelper(input: {
  action: string; body: Record<string, unknown>; request: Request; workspaceId: string;
  backendBaseUrl: string; appNpub: string; botIdentity: FlightDeckPgBotIdentity;
  sessionId: string; subscriptionId?: string | null; backendConnectionId?: string | null;
}): Promise<Response> {
  const operation = input.action.slice("context_tree_".length);
  if (!Object.hasOwn(contextOperations, operation)) return Response.json({ error: "Unknown context operation", code: "validation_error" }, { status: 400 });
  try {
    const params = contextOperations[operation as ContextOperation].schema.parse(input.body.params);
    if (params.workspace_id !== input.workspaceId) return Response.json({ error: "Context unavailable", code: "context_not_found" }, { status: 404 });
    const brokerUrl = new URL(input.request.url);
    if (!["http:", "https:"].includes(brokerUrl.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(brokerUrl.hostname)) {
      return Response.json({ error: "Context helper requires the host-local capability broker", code: "permission_denied" }, { status: 403 });
    }
    const capabilityToken = input.request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!capabilityToken) return Response.json({ error: "Session capability required", code: "permission_denied" }, { status: 403 });
    // Reuse caller's capability policy for each exact NIP-98 signature. Never
    // substitute the stored runtime secret or owner identity for denied signing.
    const signer = createBotIdentityFromCapability({
      useSessionEnvironment: false, wingmanUrl: brokerUrl.origin, sessionId: input.sessionId, capabilityToken,
      botNpub: input.botIdentity.botNpub, botPubkeyHex: input.botIdentity.botPubkeyHex,
    });
    const client = new FlightDeckPgClient({
      towerUrl: input.backendBaseUrl, wingmanUrl: brokerUrl.origin,
      appNpub: input.appNpub, subscriptionId: input.subscriptionId, backendConnectionId: input.backendConnectionId,
      botIdentity: { ...signer, ...("towerTransport" in input.botIdentity ? { towerTransport: input.botIdentity.towerTransport } : {}) },
    });
    return Response.json(await executeContextOperation(client.contextTree, operation as ContextOperation, params));
  } catch (error) {
    if (error instanceof FlightDeckPgResponseError) return Response.json(error.envelope, { status: error.status });
    if (error instanceof ZodError) return Response.json({ error: error.message, code: "validation_error" }, { status: 400 });
    if (error instanceof Error && "envelope" in error && "status" in error) return Response.json(error.envelope, { status: Number(error.status) });
    throw error;
  }
}

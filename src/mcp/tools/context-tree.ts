import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { contextOperations, type ContextOperation } from "../../flightdeck-pg/context-operations.ts";
import { callCapabilityBroker } from "../capability-client.ts";
import { registerWingmanTool } from "../register-tool.ts";

export async function handleContextTree(operation: ContextOperation, params: unknown, wingmanUrl: string, sessionId: string) {
  try {
    const parsed = contextOperations[operation].schema.parse(params);
    const payload = await callCapabilityBroker<Record<string, unknown>>("/api/mcp/wingman/flightdeck", {
      action: `context_tree_${operation}`, params: parsed,
    }, { wingmanUrl: Bun.env.WINGMAN_BROKER_URL?.trim() || wingmanUrl, sessionId, capabilityToken: Bun.env.WINGMAN_CAPABILITY?.trim() ?? "" });
    return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
  } catch (error) {
    const details = error instanceof Error && "envelope" in error ? error.envelope : {};
    return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), ...(details as Record<string, unknown>) }) }] };
  }
}
export function registerContextTreeTools(server: McpServer, wingmanUrl: string, sessionId: string): void {
  for (const [operation, spec] of Object.entries(contextOperations)) {
    registerWingmanTool(server, `flightdeck_context_tree_${operation}`, spec.description, spec.schema.shape,
      params => handleContextTree(operation as ContextOperation, params, wingmanUrl, sessionId));
  }
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

type WingmanToolSchema = Record<string, z.ZodTypeAny>;
type WingmanToolHandler = (params: never) => CallToolResult | Promise<CallToolResult>;

interface CollapsedMcpServer {
  registerTool(
    name: string,
    config: { description: string; inputSchema: WingmanToolSchema },
    callback: (params: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>,
  ): unknown;
}

export function registerWingmanTool(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: WingmanToolSchema,
  callback: WingmanToolHandler,
): void {
  // Collapse the SDK's Zod 3/Zod 4 compatibility conditional at this boundary.
  // Runtime validation still uses the exact schema before the typed Wingman
  // handler receives the parsed payload.
  const collapsedServer = server as unknown as CollapsedMcpServer;
  const sdkCallback = callback as unknown as CollapsedMcpServer["registerTool"] extends (
    name: string,
    config: infer _Config,
    callback: infer Callback,
  ) => unknown ? Callback : never;
  collapsedServer.registerTool(name, {
    description,
    inputSchema,
  }, sdkCallback);
}

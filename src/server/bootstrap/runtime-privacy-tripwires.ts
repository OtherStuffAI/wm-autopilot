import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function assertNoPersistentRootMcpConfig(repoRoot = resolve(import.meta.dir, "../../../")): void {
  const path = resolve(repoRoot, ".mcp.json");
  if (existsSync(path)) {
    throw new Error(`SECURITY: repository-root .mcp.json is unsupported; remove ${path}. MCP config is session-private.`);
  }
}

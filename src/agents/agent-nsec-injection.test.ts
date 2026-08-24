import { describe, expect, test } from "bun:test";

import {
  buildClaudeWingmanServer,
  buildGooseWingmanExtension,
  buildOpenCodeWingmanMcp,
} from "./mcp-config-helpers";
import { pickIdentityEnv } from "./mcp-injector";

describe("MCP runtime configuration secret non-propagation", () => {
  test("Claude, Goose and OpenCode configs receive public identity only", () => {
    const capability = "opaque-runtime-capability";
    const privateKey = "33".repeat(32);
    const identityEnv = pickIdentityEnv({
      WINGMAN_NPUB: "npub1instance",
      BOT_NPUB: "npub1stablebot",
      BOT_PUBKEY_HEX: "44".repeat(32),
      USER_NPUB: "npub1owner",
      WINGMAN_CAPABILITY: capability,
      AGENT_NSEC: privateKey,
      WINGMAN_PRIV: privateKey,
    });
    const configs = [
      buildClaudeWingmanServer("/mcp.ts", "http://localhost:3600", "session", identityEnv),
      buildGooseWingmanExtension("/mcp.ts", "http://localhost:3600", "session", identityEnv),
      buildOpenCodeWingmanMcp("/mcp.ts", "http://localhost:3600", "session", identityEnv),
    ];
    for (const config of configs) {
      const serialized = JSON.stringify(config);
      expect(serialized).toContain("npub1stablebot");
      expect(serialized).not.toContain(capability);
      expect(serialized).not.toContain(privateKey);
      expect(serialized).not.toContain("AGENT_NSEC");
      expect(serialized).not.toContain("WINGMAN_PRIV");
    }
  });
});

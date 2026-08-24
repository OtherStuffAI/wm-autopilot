import { describe, expect, test } from "bun:test";

import type { WingmanConfig } from "../config";
import { createAppConfig, type SessionConfig } from "./ecosystem-generator";
import { injectMcpConfig } from "./mcp-injector";
import { buildInheritedAgentEnvironment, sanitizeInjectedAgentEnvironment } from "./agent-environment";

const SECRET_MARKER = "11".repeat(32);

function sessionConfig(envOverride: Record<string, string>): SessionConfig {
  return {
    sessionId: "security-session",
    sessionName: "security",
    agent: "codex",
    port: 3700,
    workingDirectory: "/tmp",
    userAlias: "tester",
    isAdmin: false,
    config: {} as WingmanConfig,
    commandOverride: ["agentapi", "server"],
    envOverride,
  };
}

describe("agent secret non-propagation", () => {
  test("inherits only documented base variables from the Autopilot parent", () => {
    const inherited = buildInheritedAgentEnvironment({
      PATH: "/bin",
      HOME: "/safe-home",
      WINGMAN_PRIV: SECRET_MARKER,
      AGENT_NSEC: SECRET_MARKER,
      NOSTR_SECRET_KEY: SECRET_MARKER,
      RANDOM_PARENT_SECRET: SECRET_MARKER,
    });
    expect(inherited).toEqual({ PATH: "/bin", HOME: "/safe-home" });
  });

  test("strips every root/private-key variable from injected runtime env", () => {
    const clean = sanitizeInjectedAgentEnvironment({
      WINGMAN_URL: "http://localhost:3600",
      WINGMAN_CAPABILITY: "opaque-runtime-capability",
      AGENT_NSEC: SECRET_MARKER,
      WINGMAN_NSEC: SECRET_MARKER,
      WINGMAN_PRIV: SECRET_MARKER,
      KEYTELEPORT_PRIVKEY: SECRET_MARKER,
      WINGMAN_BROKER_MASTER_KEY_FILE: "/run/secrets/broker-master-key",
      WINGMAN_BROKER_MASTER_KEY: SECRET_MARKER,
      BROKER_MASTER_KEY: SECRET_MARKER,
      WINGMAN_BROKER_VAULT_BACKEND: "file",
      NOSTR_SECRET_KEY: SECRET_MARKER,
      NWC_CONNECTION_STRING: SECRET_MARKER,
    });
    expect(clean).toEqual({
      WINGMAN_URL: "http://localhost:3600",
      WINGMAN_CAPABILITY: "opaque-runtime-capability",
    });
  });

  test("PM2 ecosystem contains an opaque capability but no raw key material", () => {
    const app = createAppConfig(sessionConfig({
      WINGMAN_CAPABILITY: "opaque-runtime-capability",
      BOT_NPUB: "npub1stablebot",
      AGENT_NSEC: SECRET_MARKER,
      WINGMAN_PRIV: SECRET_MARKER,
      NWC_SECRET: SECRET_MARKER,
    }));
    expect(app.env?.WINGMAN_CAPABILITY).toBe("opaque-runtime-capability");
    expect(JSON.stringify(app)).not.toContain(SECRET_MARKER);
    expect(app.env?.AGENT_NSEC).toBeUndefined();
    expect(app.env?.WINGMAN_PRIV).toBeUndefined();
    expect(app.env?.NWC_SECRET).toBeUndefined();
  });

  test("Codex argv and generated MCP config never serialize the capability or private keys", async () => {
    const result = await injectMcpConfig({
      sessionId: "security-session",
      agent: "codex",
      workingDirectory: "/tmp",
      config: { port: 3600, baseUrl: "http://localhost:3600" } as WingmanConfig,
      wingmanNpub: "npub1instance",
      botNpub: "npub1stablebot",
      botPubkeyHex: "22".repeat(32),
      userNpub: "npub1owner",
      capabilityToken: "opaque-runtime-capability",
    });
    expect(result.env.WINGMAN_CAPABILITY).toBe("opaque-runtime-capability");
    const serializedConfig = JSON.stringify(result.codexConfig);
    const serializedArgs = JSON.stringify(result.commandArgs);
    expect(serializedConfig).not.toContain("opaque-runtime-capability");
    expect(serializedArgs).not.toContain("opaque-runtime-capability");
    expect(serializedConfig).not.toContain("AGENT_NSEC");
    expect(serializedArgs).not.toContain("AGENT_NSEC");
    expect(serializedConfig).toContain("WINGMAN_CAPABILITY");
    expect(serializedArgs).toContain("WINGMAN_CAPABILITY");
  });
});

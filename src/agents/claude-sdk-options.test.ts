import { describe, expect, test } from "bun:test";
import { buildClaudeSdkEnvironment, sanitizeClaudeSdkError } from "./claude-sdk-options";
import { buildClaudeAdapterContext } from "./claude-adapter-context";
import { applyClaudeSubscriptionAuth } from "./agent-environment";
import type { AdapterSessionContext } from "./agent-adapter";

const context = { id: "child-session", agent: "claude", port: 3700, host: "127.0.0.1", workingDirectory: "/tmp/project" } as AdapterSessionContext;

describe("Claude SDK credentials", () => {
  test("inherits only allowed host values; session credentials remain scoped", () => {
    const before = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "host-secret";
    try {
      const env = buildClaudeSdkEnvironment({ ...context, env: {
        CLAUDE_CODE_OAUTH_TOKEN: "saved-token", WINGMAN_CAPABILITY: "session-capability", AGENT_NSEC: "forbidden",
      } });
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.AGENT_NSEC).toBeUndefined();
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("saved-token");
      expect(env.SESSION_ID).toBe("child-session");
      expect(env.PATH).toBeTruthy();
    } finally { if (before === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = before; }
  });

  test("preserves credits proxy credentials and excludes subscription OAuth", () => {
    const env = buildClaudeSdkEnvironment({ ...context, env: applyClaudeSubscriptionAuth({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:3600/api/provider/anthropic", ANTHROPIC_API_KEY: "credits-token",
      CLAUDE_CODE_OAUTH_TOKEN: "host-token",
    }, { agent: "claude", billingMode: "credits", oauthToken: "saved-token" }) });
    expect(env.ANTHROPIC_API_KEY).toBe("credits-token");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  test("rehydration without reissued credits auth fails clearly", () => {
    expect(() => buildClaudeAdapterContext({ ...context, command: ["agentapi", "--", "claude"],
      definition: {}, metadata: { AGENT: true, billingMode: "credits", agentTransport: "claude-sdk" },
    }, "saved-token")).toThrow("credits authentication must be reissued");
  });

  test("redacts configured credentials and token-shaped secrets from errors", () => {
    const error = sanitizeClaudeSdkError(new Error("OAuth saved-token; broker capability; sk-ant-oat01-secret"), {
      CLAUDE_CODE_OAUTH_TOKEN: "saved-token", WINGMAN_CAPABILITY: "capability",
    });
    expect(error.message).toBe("OAuth [redacted]; broker [redacted]; [redacted]");
  });
});

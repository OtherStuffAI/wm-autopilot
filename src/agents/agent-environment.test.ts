import { describe, expect, test } from "bun:test";

import { applyClaudeSubscriptionAuth, CLAUDE_OAUTH_TOKEN_ENV_KEY } from "./agent-environment";

describe("applyClaudeSubscriptionAuth", () => {
  test("injects the configured token into subscription Claude sessions", () => {
    const env = applyClaudeSubscriptionAuth({ EXISTING: "1" }, {
      agent: "claude",
      billingMode: "subscription",
      oauthToken: "  oauth-token  ",
    });
    expect(env).toEqual({ EXISTING: "1", [CLAUDE_OAUTH_TOKEN_ENV_KEY]: "oauth-token" });
  });

  test("strips the token from credits Claude sessions", () => {
    const env = applyClaudeSubscriptionAuth(
      { ANTHROPIC_API_KEY: "proxy", [CLAUDE_OAUTH_TOKEN_ENV_KEY]: "stale" },
      { agent: "claude", billingMode: "credits", oauthToken: "oauth-token" },
    );
    expect(env).toEqual({ ANTHROPIC_API_KEY: "proxy" });
  });

  test("never gives the token to other agents", () => {
    const env = applyClaudeSubscriptionAuth(
      { [CLAUDE_OAUTH_TOKEN_ENV_KEY]: "stale" },
      { agent: "codex", billingMode: "subscription", oauthToken: "oauth-token" },
    );
    expect(env[CLAUDE_OAUTH_TOKEN_ENV_KEY]).toBeUndefined();
  });

  test("falls back to the local Claude login when no token is configured", () => {
    const env = applyClaudeSubscriptionAuth(undefined, {
      agent: "claude",
      billingMode: "subscription",
      oauthToken: "   ",
    });
    expect(env).toEqual({});
  });
});

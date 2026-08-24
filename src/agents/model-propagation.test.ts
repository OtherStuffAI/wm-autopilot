import { describe, expect, test } from "bun:test";

import { buildGooseRuntimeEnv } from "./goose-adapter";
import { buildPiRpcArgs } from "./pi-rpc-client";
import type { AdapterSessionContext } from "./agent-adapter";

describe("runtime model propagation", () => {
  test("passes Goose a provider-relative model through its environment contract", () => {
    const env = buildGooseRuntimeEnv({
      id: "goose-session",
      port: 3700,
      agent: "goose",
      host: "127.0.0.1",
      model: "anthropic/claude-opus-5-fast",
      gooseProvider: "openrouter",
      env: {},
    } satisfies AdapterSessionContext);

    expect(env.GOOSE_PROVIDER).toBe("openrouter");
    expect(env.GOOSE_MODEL).toBe("anthropic/claude-opus-5-fast");
  });

  test("keeps the fixed OpenRouter provider when a legacy provider value is also present", () => {
    const env = buildGooseRuntimeEnv({
      id: "goose-session",
      port: 3700,
      agent: "goose",
      host: "127.0.0.1",
      model: "qwen/qwen3.7-flash",
      gooseProvider: "openai",
      env: { GOOSE_PROVIDER: "openrouter" },
    });

    expect(env.GOOSE_PROVIDER).toBe("openrouter");
  });

  test("passes Pi its OpenRouter-qualified model on RPC startup", () => {
    expect(buildPiRpcArgs({
      sessionDirectory: "/tmp/pi-session",
      model: "openrouter/anthropic/claude-opus-5-fast",
    })).toEqual([
      "--model",
      "openrouter/anthropic/claude-opus-5-fast",
      "--mode",
      "rpc",
      "--session-dir",
      "/tmp/pi-session",
    ]);
  });
});

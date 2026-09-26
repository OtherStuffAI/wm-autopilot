import { describe, expect, test } from "bun:test";

import { buildCodexRuntimeEnv } from "./codex-runtime-env";

describe("buildCodexRuntimeEnv", () => {
  test("keeps server provider credentials out of subscription sessions", () => {
    const env = buildCodexRuntimeEnv({
      PATH: "/usr/bin",
      CODEX_API_KEY: "server-codex-key",
      OPENAI_API_KEY: "server-openai-key",
      OPENAI_BASE_URL: "https://server.example",
      PIPELINE_CLASSIFIER_OPENROUTER_API_KEY: "classifier-key",
      OPENROUTER_API_KEY: "openrouter-key",
      WINGMAN_BROKER_MASTER_KEY: "server-broker-secret",
    });

    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  test("preserves explicit session billing credentials", () => {
    const env = buildCodexRuntimeEnv(
      { OPENAI_API_KEY: "server-key", PATH: "/usr/bin" },
      {
        CODEX_API_KEY: "session-token",
        OPENAI_BASE_URL: "https://proxy.example",
      },
    );

    expect(env).toEqual({
      PATH: "/usr/bin",
      CODEX_API_KEY: "session-token",
      OPENAI_BASE_URL: "https://proxy.example",
    });
  });

  test("rejects forbidden server secrets even when injected into a session", () => {
    const env = buildCodexRuntimeEnv({}, {
      WINGMAN_BROKER_MASTER_KEY: "server-secret",
      WINGMAN_CAPABILITY: "session-capability",
    });

    expect(env).toEqual({ WINGMAN_CAPABILITY: "session-capability" });
  });
});

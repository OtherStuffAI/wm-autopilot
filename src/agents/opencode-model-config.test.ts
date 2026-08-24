import { describe, expect, test } from "bun:test";

import {
  buildOpenCodeModelConfigContent,
  OPENCODE_CONFIG_CONTENT_ENV,
  withOpenCodeModelConfigEnvironment,
} from "./opencode-model-config";

const CURRENT_OPENROUTER_MODELS = [
  "moonshotai/kimi-k3",
  "qwen/qwen3.7-flash",
  "anthropic/claude-opus-5-fast",
  "google/gemini-3.6-flash",
  "thinkingmachines/inkling",
  "deepseek/deepseek-v4-flash-0731",
];

function modelKeys(content: string): string[] {
  const config = JSON.parse(content) as {
    provider: { openrouter: { models: Record<string, unknown> } };
  };
  return Object.keys(config.provider.openrouter.models);
}

describe("OpenCode OpenRouter model config", () => {
  test("adds the currently configured Autopilot models to OpenCode", () => {
    expect(modelKeys(buildOpenCodeModelConfigContent(CURRENT_OPENROUTER_MODELS)))
      .toEqual(CURRENT_OPENROUTER_MODELS);
  });

  test("reflects dynamic additions and removals without a second model list", () => {
    const initial = buildOpenCodeModelConfigContent([
      "qwen/qwen3.7-flash",
      "thinkingmachines/inkling",
    ]);
    const changed = buildOpenCodeModelConfigContent([
      "thinkingmachines/inkling",
      "newvendor/new-model",
    ]);

    expect(modelKeys(initial)).toEqual(["qwen/qwen3.7-flash", "thinkingmachines/inkling"]);
    expect(modelKeys(changed)).toEqual(["thinkingmachines/inkling", "newvendor/new-model"]);
  });

  test("preserves existing inline provider settings, model overrides, and unrelated config", () => {
    const content = buildOpenCodeModelConfigContent(
      ["qwen/qwen3.7-flash"],
      JSON.stringify({
        permission: "ask",
        provider: {
          openrouter: {
            options: { timeout: 120_000 },
            models: { "qwen/qwen3.7-flash": { name: "Qwen Flash" } },
          },
          maple: { models: { "maple-model": {} } },
        },
      }),
    );

    expect(JSON.parse(content)).toMatchObject({
      permission: "ask",
      provider: {
        openrouter: {
          options: { timeout: 120_000 },
          models: { "qwen/qwen3.7-flash": { name: "Qwen Flash" } },
        },
        maple: { models: { "maple-model": {} } },
      },
    });
  });

  test("injects the generated overlay into the spawned OpenCode environment", () => {
    const env = withOpenCodeModelConfigEnvironment(
      { KEEP_ME: "yes" },
      ["qwen/qwen3.7-flash"],
      JSON.stringify({ permission: "ask" }),
    );

    expect(env.KEEP_ME).toBe("yes");
    expect(JSON.parse(env[OPENCODE_CONFIG_CONTENT_ENV]!)).toMatchObject({
      permission: "ask",
      provider: {
        openrouter: {
          models: { "qwen/qwen3.7-flash": {} },
        },
      },
    });
  });

  test("surfaces malformed inline config and unsupported model entries", () => {
    expect(() => buildOpenCodeModelConfigContent(["qwen/qwen3.7-flash"], "not json"))
      .toThrow(`${OPENCODE_CONFIG_CONTENT_ENV} must contain valid JSON`);
    expect(() => buildOpenCodeModelConfigContent(["openrouter/qwen/qwen3.7-flash"]))
      .toThrow("must omit the openrouter/ prefix");
    expect(() => buildOpenCodeModelConfigContent(["qwen/qwen3.7-flash#high"]))
      .toThrow("variants are not supported");
  });
});

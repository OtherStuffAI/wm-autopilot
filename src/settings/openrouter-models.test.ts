import { describe, expect, test } from "bun:test";

import {
  getConfiguredOpenRouterModels,
  normalizeOpenRouterModelLines,
  resolveAgentModelOptions,
  resolveOpenCodeOpenRouterModelAvailability,
  resolveRuntimeModel,
  serializeModelProviderSettings,
} from "./openrouter-models";

describe("OpenRouter model settings", () => {
  test("trims lines, removes blanks, and de-duplicates in first-seen order", () => {
    expect(normalizeOpenRouterModelLines(`
      qwen/qwen3.7-flash

      anthropic/claude-opus-5-fast
      qwen/qwen3.7-flash
      google/gemini-3.6-flash
    `)).toEqual([
      "qwen/qwen3.7-flash",
      "anthropic/claude-opus-5-fast",
      "google/gemini-3.6-flash",
    ]);
  });

  test("rejects empty, prefixed, and malformed model IDs", () => {
    expect(() => normalizeOpenRouterModelLines("\n  \n")).toThrow("at least one");
    expect(() => normalizeOpenRouterModelLines("openrouter/qwen/qwen3.7-flash")).toThrow("provider/model");
    expect(() => normalizeOpenRouterModelLines("Claude/Opus")).toThrow("provider/model");
    expect(() => normalizeOpenRouterModelLines("missing-slash")).toThrow("provider/model");
  });

  test("round-trips the extensible provider shape", () => {
    const value = serializeModelProviderSettings(["qwen/qwen3.7-flash", "qwen/qwen3.7-flash"]);
    expect(getConfiguredOpenRouterModels(value)).toEqual(["qwen/qwen3.7-flash"]);
  });

  test("preserves legacy options without a setting and replaces supported launchers when configured", () => {
    const legacy = ["default", "opencode/big-pickle", "openrouter/moonshotai/kimi-k3"];
    expect(resolveAgentModelOptions("opencode", legacy, null)).toEqual(legacy);
    const setting = serializeModelProviderSettings(["qwen/qwen3.7-flash", "anthropic/claude-opus-5-fast"]);
    expect(resolveAgentModelOptions("goose", legacy, setting)).toEqual([
      "default",
      "qwen/qwen3.7-flash",
      "anthropic/claude-opus-5-fast",
    ]);
    expect(resolveAgentModelOptions("pi", ["default"], setting)).toEqual([
      "default",
      "qwen/qwen3.7-flash",
      "anthropic/claude-opus-5-fast",
    ]);
    expect(resolveAgentModelOptions("codex", legacy, setting)).toEqual(legacy);
  });

  test("uses the current configured set for OpenCode and reflects additions and removals", () => {
    const current = serializeModelProviderSettings([
      "moonshotai/kimi-k3",
      "qwen/qwen3.7-flash",
      "anthropic/claude-opus-5-fast",
      "google/gemini-3.6-flash",
      "thinkingmachines/inkling",
      "deepseek/deepseek-v4-flash-0731",
    ]);
    expect(resolveAgentModelOptions("opencode", ["default"], current)).toEqual([
      "default",
      "moonshotai/kimi-k3",
      "qwen/qwen3.7-flash",
      "anthropic/claude-opus-5-fast",
      "google/gemini-3.6-flash",
      "thinkingmachines/inkling",
      "deepseek/deepseek-v4-flash-0731",
    ]);

    const changed = serializeModelProviderSettings([
      "thinkingmachines/inkling",
      "newvendor/new-model",
    ]);
    expect(resolveAgentModelOptions("opencode", ["default"], changed)).toEqual([
      "default",
      "thinkingmachines/inkling",
      "newvendor/new-model",
    ]);
  });

  test("classifies malformed and intentionally unsupported OpenCode entries", () => {
    expect(resolveOpenCodeOpenRouterModelAvailability([
      "qwen/qwen3.7-flash",
      "openrouter/qwen/qwen3.7-flash",
      "qwen/qwen3.7-flash#high",
      "missing-slash",
    ])).toEqual({
      available: ["qwen/qwen3.7-flash"],
      unsupported: [
        {
          model: "openrouter/qwen/qwen3.7-flash",
          reason: "OpenCode OpenRouter model IDs must omit the openrouter/ prefix",
        },
        {
          model: "qwen/qwen3.7-flash#high",
          reason: "OpenCode model variants are not supported in Autopilot OpenRouter availability",
        },
        {
          model: "missing-slash",
          reason: "OpenCode OpenRouter models must use provider/model format",
        },
      ],
    });
  });

  test("encodes selected models at each runtime boundary", () => {
    const configured = ["anthropic/claude-opus-5-fast"];
    expect(resolveRuntimeModel("goose", "anthropic/claude-opus-5-fast", configured)).toBe(
      "anthropic/claude-opus-5-fast",
    );
    expect(resolveRuntimeModel("opencode", "anthropic/claude-opus-5-fast", configured)).toBe(
      "openrouter/anthropic/claude-opus-5-fast",
    );
    expect(resolveRuntimeModel("pi", "anthropic/claude-opus-5-fast", configured)).toBe(
      "openrouter/anthropic/claude-opus-5-fast",
    );
    expect(resolveRuntimeModel("opencode", "opencode/big-pickle", null)).toBe("opencode/big-pickle");
  });

  test("rejects an OpenCode selection outside the configured source before launch", () => {
    expect(() => resolveRuntimeModel(
      "opencode",
      "anthropic/removed-model",
      ["anthropic/claude-opus-5-fast"],
    )).toThrow("is not in the configured Autopilot OpenRouter model list");
  });
});

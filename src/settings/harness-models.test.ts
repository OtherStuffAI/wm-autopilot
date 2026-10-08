import { describe, expect, test } from "bun:test";
import {
  getConfiguredHarnessModels,
  isModelUnavailableError,
  parseHarnessModelSettings,
  resolveHarnessModelOptions,
  resolveLaunchModelForHarness,
  serializeHarnessModelSettings,
} from "./harness-models";
import { readAgentModelSettings, resolveAgentModelCatalogue } from "../server/agent-model-catalogue";
import { HARNESS_MODELS_SETTING_KEY } from "./harness-models";
import { MODEL_PROVIDERS_SETTING_KEY } from "./openrouter-models";

const saved = (harnesses: Record<string, unknown>) => JSON.stringify({ harnesses });

describe("harness model settings", () => {
  test("normalizes lists: trims, dedupes and drops the implicit default", () => {
    const settings = parseHarnessModelSettings(saved({
      codex: { models: [" gpt-6.1-sol ", "default", "gpt-6.1-sol", "gpt-5.6-luna"], source: "cli", updatedAt: "2026-10-08T00:00:00.000Z" },
      claude: { models: ["claude-opus-5-5", "sonnet[1m]"] },
    }));
    expect(settings.harnesses.codex).toEqual({
      models: ["gpt-6.1-sol", "gpt-5.6-luna"], source: "cli", updatedAt: "2026-10-08T00:00:00.000Z",
    });
    expect(settings.harnesses.claude?.models).toEqual(["claude-opus-5-5", "sonnet[1m]"]);
    expect(settings.harnesses.claude?.source).toBe("manual");
    expect(JSON.parse(serializeHarnessModelSettings(settings))).toEqual(settings);
  });

  test("rejects unsupported harnesses, empty lists and invalid IDs", () => {
    expect(() => parseHarnessModelSettings(saved({ goose: { models: ["x"] } }))).toThrow("Unsupported harness");
    expect(() => parseHarnessModelSettings(saved({ codex: { models: ["default"] } }))).toThrow("at least one");
    expect(() => parseHarnessModelSettings(saved({ claude: { models: ["bad model; rm"] } }))).toThrow("not a valid model ID");
    expect(() => parseHarnessModelSettings("not json")).toThrow("valid JSON");
  });

  test("a saved list replaces built-ins only for that harness", () => {
    const value = saved({ codex: { models: ["gpt-6.1-sol"] } });
    expect(resolveHarnessModelOptions("codex", ["default", "gpt-5.5"], value)).toEqual(["default", "gpt-6.1-sol"]);
    expect(resolveHarnessModelOptions("claude", ["default", "opus"], value)).toEqual(["default", "opus"]);
    expect(resolveHarnessModelOptions("goose", ["default", "x/y"], value)).toEqual(["default", "x/y"]);
    expect(resolveHarnessModelOptions("codex", ["default", "gpt-5.5"], null)).toEqual(["default", "gpt-5.5"]);
  });

  test("an invalid stored value falls back to built-ins instead of breaking launches", () => {
    expect(getConfiguredHarnessModels("codex", "{broken")).toBeNull();
  });

  test("launch guard keeps listed models and falls back to default otherwise", () => {
    const options = ["default", "gpt-6.1-sol"];
    expect(resolveLaunchModelForHarness("codex", "gpt-6.1-sol", options)).toEqual({ model: "gpt-6.1-sol", fallbackFrom: null });
    expect(resolveLaunchModelForHarness("codex", "gpt-5.4-mini", options)).toEqual({ model: "", fallbackFrom: "gpt-5.4-mini" });
    expect(resolveLaunchModelForHarness("codex", "", options)).toEqual({ model: "", fallbackFrom: null });
    expect(resolveLaunchModelForHarness("opencode", "anything/else", ["default"])).toEqual({ model: "anything/else", fallbackFrom: null });
  });

  test("recognizes the CLIs' unavailable-model errors", () => {
    expect(isModelUnavailableError(new Error(
      "Claude SDK turn failed: There's an issue with the selected model (claude-bogus-9-9). It may not exist or you may not have access to it.",
    ))).toBe(true);
    expect(isModelUnavailableError(new Error(
      "The 'gpt-bogus-9' model is not supported when using Codex with a ChatGPT account.",
    ))).toBe(true);
    expect(isModelUnavailableError(new Error("Codex turn failed: rate limit exceeded"))).toBe(false);
    expect(isModelUnavailableError(new Error("Native completed assistant output missing"))).toBe(false);
  });
});

describe("agent model catalogue", () => {
  test("combines harness lists with the separate OpenRouter provider list", () => {
    const values: Record<string, string> = {
      [HARNESS_MODELS_SETTING_KEY]: saved({ claude: { models: ["claude-fable-5-1"] } }),
      [MODEL_PROVIDERS_SETTING_KEY]: JSON.stringify({ providers: { openrouter: { models: ["moonshotai/kimi-k3"] } } }),
    };
    const settings = readAgentModelSettings({ get: (key) => values[key] ?? null });
    expect(resolveAgentModelCatalogue({
      claude: { label: "Claude", modelOptions: ["default", "opus"] },
      codex: { label: "Codex", modelOptions: ["default", "gpt-6.1-sol"] },
      goose: { label: "Goose", modelOptions: ["default"] },
    }, settings)).toEqual([
      { id: "claude", label: "Claude", modelOptions: ["default", "claude-fable-5-1"] },
      { id: "codex", label: "Codex", modelOptions: ["default", "gpt-6.1-sol"] },
      { id: "goose", label: "Goose", modelOptions: ["default", "moonshotai/kimi-k3"] },
    ]);
  });
});

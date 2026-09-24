import { describe, expect, test } from "bun:test";
import { resolveClassifierOpenRouterApiKey } from "./classifier-openrouter-credentials";

function context(input: {
  instance?: Record<string, string>;
  owner?: Record<string, string>;
  env?: Record<string, string | undefined>;
} = {}) {
  return {
    ownerNpub: "npub1owner",
    sessionApiContext: {
      userSettingsStore: { getAll: (npub: string) => npub === "npub1owner" ? input.owner ?? {} : {} },
      getStoredInstanceSetting: (key: string) => input.instance?.[key] ?? null,
    },
    env: input.env ?? {},
  };
}

describe("classifier OpenRouter credential resolution", () => {
  test("prefers classifier-specific configuration", () => {
    expect(resolveClassifierOpenRouterApiKey(context({
      instance: {
        "pipelines.classifier_openrouter_api_key": "classifier-instance",
        "integrations.openrouter_api_key": "runtime-instance",
      },
      owner: { openrouter_api_key: "owner-openrouter" },
      env: { PIPELINE_CLASSIFIER_OPENROUTER_API_KEY: "classifier-env", OPENROUTER_API_KEY: "runtime-env" },
    }))).toBe("classifier-instance");
  });

  test("prefers the owner OpenRouter key before the shared instance runtime key", () => {
    expect(resolveClassifierOpenRouterApiKey(context({
      instance: { "integrations.openrouter_api_key": "runtime-instance" },
      owner: { openrouter_api_key: "owner-openrouter" },
    }))).toBe("owner-openrouter");
  });

  test("uses the stored instance runtime key when the owner has no key", () => {
    expect(resolveClassifierOpenRouterApiKey(context({
      instance: { "integrations.openrouter_api_key": "runtime-instance" },
    }))).toBe("runtime-instance");
  });

  test("preserves owner legacy and environment fallbacks", () => {
    expect(resolveClassifierOpenRouterApiKey(context({ owner: { speech_api_key: "owner-speech" } }))).toBe("owner-speech");
    expect(resolveClassifierOpenRouterApiKey(context({ env: { PIPELINE_CLASSIFIER_OPENROUTER_API_KEY: "classifier-env" } }))).toBe("classifier-env");
    expect(resolveClassifierOpenRouterApiKey(context({ env: { OPENROUTER_API_KEY: "runtime-env" } }))).toBe("runtime-env");
    expect(resolveClassifierOpenRouterApiKey(context({ env: { OPENROUTER_API: "legacy-env" } }))).toBe("legacy-env");
  });

  test("rejects missing configuration without including candidate secrets", () => {
    const secret = "not-a-real-key";
    let message = "";
    try {
      resolveClassifierOpenRouterApiKey(context({ owner: { openrouter_api_key: "   " }, env: { OPENROUTER_API_KEY: "" } }));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("Classifier OpenRouter API key is not configured");
    expect(message).not.toContain(secret);
  });
});

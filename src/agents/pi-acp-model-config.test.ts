import { describe, expect, mock, test } from "bun:test";

import type { AcpProcessClient, AcpResponse } from "./acp-process-client";
import { configureAdvertisedPiModel, parsePiModelIdentifier } from "./pi-acp-model-config";

function sessionResponse(values: string[], currentValue = values[0] ?? null): AcpResponse {
  return {
    result: {
      sessionId: "pi-session",
      configOptions: [{
        id: "model",
        currentValue,
        options: values.map((value) => ({ value, name: value })),
      }],
    },
  };
}

describe("Pi ACP advertised model configuration", () => {
  test("preserves every model segment after the provider", () => {
    expect(parsePiModelIdentifier("openrouter/accounts/fireworks/models/kimi-k2p6")).toEqual({
      provider: "openrouter",
      modelId: "accounts/fireworks/models/kimi-k2p6",
    });
  });

  test("selects an exact advertised provider/model value and confirms it", async () => {
    const model = "openrouter/google/gemini-3.6-flash";
    const request = mock(async () => sessionResponse([model], model));
    await configureAdvertisedPiModel(
      { request } as unknown as AcpProcessClient,
      "pi-session",
      sessionResponse([model], "openai-codex/gpt-5.4"),
      model,
    );
    expect(request).toHaveBeenCalledWith("session/set_config_option", {
      sessionId: "pi-session",
      configId: "model",
      value: model,
    });
  });

  test("does not issue a model request for the deliberate default path", async () => {
    const request = mock(async () => ({}));
    await configureAdvertisedPiModel(
      { request } as unknown as AcpProcessClient,
      "pi-session",
      sessionResponse(["openai-codex/gpt-5.4"]),
      undefined,
    );
    expect(request).not.toHaveBeenCalled();
  });

  test("rejects an unavailable model before sending it to the bridge", async () => {
    const request = mock(async () => ({}));
    await expect(configureAdvertisedPiModel(
      { request } as unknown as AcpProcessClient,
      "pi-session",
      sessionResponse(["openrouter/google/gemini-3.6-flash"]),
      "openrouter/google/unavailable",
    )).rejects.toThrow("not advertised by this session");
    expect(request).not.toHaveBeenCalled();
  });

  test("surfaces provider authentication when no provider models are advertised", async () => {
    await expect(configureAdvertisedPiModel(
      { request: mock(async () => ({})) } as unknown as AcpProcessClient,
      "pi-session",
      sessionResponse(["openai-codex/gpt-5.4"]),
      "openrouter/google/gemini-3.6-flash",
    )).rejects.toThrow('provider "openrouter" is not authenticated or exposes no models');
  });

  test("includes the bridge detail when an advertised selection fails", async () => {
    const model = "openrouter/google/gemini-3.6-flash";
    const request = mock(async () => ({
      error: {
        code: -32603,
        message: "Internal error",
        data: { details: "pi set_model failed: provider returned 401 unauthorized" },
      },
    }));
    await expect(configureAdvertisedPiModel(
      { request } as unknown as AcpProcessClient,
      "pi-session",
      sessionResponse([model]),
      model,
    )).rejects.toThrow("provider returned 401 unauthorized");
  });
});

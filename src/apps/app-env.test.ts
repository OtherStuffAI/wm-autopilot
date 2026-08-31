if (!Bun.env.IDENTITY_SESSION_SECRET) {
  Bun.env.IDENTITY_SESSION_SECRET = "TestSecretValue_With-Numbers123!AndSymbols@2026";
}

import { describe, expect, test } from "bun:test";

import {
  hydrateAppEnv,
  parseAppEnvInput,
  redactAppEnv,
  serialiseAppEnvForStorage,
} from "./app-env";

describe("app env helpers", () => {
  test("parses retained and changed entries without exposing values", () => {
    const parsed = parseAppEnvInput(
      [
        { key: "OPENAI_API_KEY", retain: true },
        { key: "APP_MODE", value: "demo" },
      ],
      { OPENAI_API_KEY: "sk-existing" },
    );

    expect(parsed).toEqual({
      APP_MODE: "demo",
      OPENAI_API_KEY: "sk-existing",
    });
    expect(redactAppEnv(parsed)).toEqual([
      { key: "APP_MODE", hasValue: true },
      { key: "OPENAI_API_KEY", hasValue: true },
    ]);
  });

  test("encrypts values for storage and hydrates them for runtime use", () => {
    const stored = serialiseAppEnvForStorage({ API_TOKEN: "secret-token" });

    expect(stored?.API_TOKEN).toStartWith("enc::");
    expect(stored?.API_TOKEN).not.toContain("secret-token");
    expect(hydrateAppEnv(stored)).toEqual({ API_TOKEN: "secret-token" });
  });

  test("rejects reserved runtime keys", () => {
    expect(() => parseAppEnvInput([{ key: "APP_ID", value: "override" }])).toThrow(
      "managed by Wingman",
    );
  });

  test("allows WApp-facing runtime keys to support local app setup", () => {
    expect(parseAppEnvInput([{ key: "WAPP_OWNER_NPUB", value: "npub1owner" }])).toEqual({
      WAPP_OWNER_NPUB: "npub1owner",
    });
  });

  test("never hydrates or serializes raw signing credentials", () => {
    const input = {
      API_TOKEN: "ordinary-secret",
      WAPP_NSEC: "nsec1must-not-survive",
      WAPP_TOWER_DB_CAPABILITY: "must-not-be-configured",
      AGENT_NSEC: "f".repeat(64),
    };
    expect(hydrateAppEnv(input)).toEqual({ API_TOKEN: "ordinary-secret" });
    const stored = serialiseAppEnvForStorage(input);
    expect(stored).toHaveProperty("API_TOKEN");
    expect(stored).not.toHaveProperty("WAPP_NSEC");
    expect(stored).not.toHaveProperty("WAPP_TOWER_DB_CAPABILITY");
    expect(stored).not.toHaveProperty("AGENT_NSEC");
  });
});

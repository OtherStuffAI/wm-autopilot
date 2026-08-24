if (!Bun.env.IDENTITY_SESSION_SECRET) {
  Bun.env.IDENTITY_SESSION_SECRET = "TestSecretValue_With-Numbers123!AndSymbols@2026";
}

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { InstanceSettingsStore } from "../storage/instance-settings-store";
import { InstanceSettingsService } from "./instance-settings-service";
import { getInstanceSettingDefinition } from "./instance-settings-registry";

const makeTempDir = () => mkdtempSync(join(tmpdir(), `instance-settings-service-${randomUUID()}-`));

describe("InstanceSettingsService", () => {
  let tempDir: string;
  let store: InstanceSettingsStore;
  let service: InstanceSettingsService;

  beforeEach(() => {
    tempDir = makeTempDir();
    store = new InstanceSettingsStore(join(tempDir, "settings.sqlite"));
    service = new InstanceSettingsService(store);
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("auto-imports only eligible missing settings", () => {
    const result = service.autoImportMissing({
      IDENTITY_SESSION_SECRET: Bun.env.IDENTITY_SESSION_SECRET,
      GITEA_URL: "https://git.example.test",
      PORT: "3600",
    });

    expect(result.imported).toContainEqual({ key: "integrations.gitea_url", envKey: "GITEA_URL" });
    expect(result.imported.some((item) => item.key === "runtime.port")).toBe(false);
    expect(store.getRecord("integrations.gitea_url")?.source).toBe("env_auto_import");
    expect(store.get("integrations.gitea_url")).toBe("https://git.example.test");
  });

  test("persists and validates the ACP permission default", () => {
    expect(service.get("agents.acp_permission_policy", {})).toBeNull();
    expect(service.set("agents.acp_permission_policy", " ASK ").value).toBe("ask");
    expect(service.get("agents.acp_permission_policy", {})).toBe("ask");
    expect(() => service.set("agents.acp_permission_policy", "approve_everything"))
      .toThrow("ACP permission policy must be auto_approve or ask");
  });

  test("exposes and validates the absolute Maple Desktop connector path", () => {
    expect(getInstanceSettingDefinition("agents.maple_acp_cli")?.defaultValue)
      .toBe("/Applications/Maple.app/Contents/MacOS/maple");
    expect(() => service.set("agents.maple_acp_cli", "maple")).toThrow("absolute path");
    expect(service.set("agents.maple_acp_cli", "/Applications/Maple.app/Contents/MacOS/maple").value)
      .toBe("/Applications/Maple.app/Contents/MacOS/maple");
  });

  test("keeps admin npubs and the identity session secret environment-managed", () => {
    store.set({
      key: "identity.admin_npubs",
      value: "npub1staleadmin",
      valueKind: "list",
      source: "app",
      sourceDetail: null,
    });
    store.set({
      key: "runtime.identity_session_secret",
      value: "stale-session-secret",
      valueKind: "secret",
      source: "app",
      sourceDetail: null,
    });

    const env = {
      ADMIN_NPUB: "npub1freshadmin",
      IDENTITY_SESSION_SECRET: "fresh-session-secret",
    };

    expect(service.get("identity.admin_npubs", env)).toBe("npub1freshadmin");
    expect(service.get("runtime.identity_session_secret", env)).toBe("fresh-session-secret");
    expect(service.buildRuntimeEnv(env)).not.toHaveProperty("ADMIN_NPUB");

    const result = service.autoImportMissing(env);
    expect(result.imported.some((item) => item.key === "identity.admin_npubs")).toBe(false);
    expect(result.imported.some((item) => item.key === "runtime.identity_session_secret")).toBe(false);
  });

  test("does not allow admin npubs to be saved in app settings", () => {
    expect(() => service.set("identity.admin_npubs", "npub1admin")).toThrow(
      "Bootstrap-only settings cannot be saved in app settings",
    );
  });

  test("does not auto-import conflicting aliases", async () => {
    const result = service.autoImportMissing({
      IDENTITY_SESSION_SECRET: Bun.env.IDENTITY_SESSION_SECRET,
      APP_ROUTING: "path",
      WINGMAN_APP_ROUTING: "subdomain",
    });

    expect(result.imported.some((item) => item.key === "runtime.app_routing")).toBe(false);
    const preview = await service.previewEnvImport({
      IDENTITY_SESSION_SECRET: Bun.env.IDENTITY_SESSION_SECRET,
      APP_ROUTING: "path",
      WINGMAN_APP_ROUTING: "subdomain",
    });
    const candidate = preview.candidates.find((item) => item.key === "runtime.app_routing");
    expect(candidate?.blockedReason).toBe("conflicting env aliases");
  });

  test("masks secrets in import previews", async () => {
    const preview = await service.previewEnvImport({
      IDENTITY_SESSION_SECRET: Bun.env.IDENTITY_SESSION_SECRET,
      GITEA_API_TOKEN: "secret-token-value",
    });
    const candidate = preview.candidates.find((item) => item.key === "integrations.gitea_api_token");

    expect(candidate?.maskedEnvValue).toBe("secr..alue");
    expect(JSON.stringify(candidate)).not.toContain("secret-token-value");
  });

  test("backs up and removes selected env keys only when requested", async () => {
    const envPath = join(tempDir, ".env");
    writeFileSync(envPath, "GITEA_URL=https://git.example.test\nPORT=3600\n", "utf8");

    const result = await service.cleanupEnvFile(["integrations.gitea_url"], {
      IDENTITY_SESSION_SECRET: Bun.env.IDENTITY_SESSION_SECRET,
      WINGMAN_ENV_FILE: envPath,
    });

    expect(result.removedKeys).toEqual(["GITEA_URL"]);
    expect(readFileSync(result.backupPath, "utf8")).toContain("GITEA_URL=https://git.example.test");
    const nextEnv = readFileSync(envPath, "utf8");
    expect(nextEnv).not.toContain("GITEA_URL=");
    expect(nextEnv).toContain("PORT=3600");
  });

  test("normalizes model provider settings and leaves the last valid value after a rejected save", () => {
    const first = service.set("models.providers", JSON.stringify({
      providers: {
        openrouter: {
          models: [" qwen/qwen3.7-flash ", "anthropic/claude-opus-5-fast", "qwen/qwen3.7-flash"],
        },
      },
    }));

    expect(JSON.parse(first.value)).toEqual({
      providers: {
        openrouter: {
          models: ["qwen/qwen3.7-flash", "anthropic/claude-opus-5-fast"],
        },
      },
    });

    expect(() => service.set("models.providers", JSON.stringify({
      providers: { openrouter: { models: ["not-a-model"] } },
    }))).toThrow("provider/model");
    expect(store.get("models.providers")).toBe(first.value);
  });
});

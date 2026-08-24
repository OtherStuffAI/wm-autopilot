if (!Bun.env.IDENTITY_SESSION_SECRET) {
  Bun.env.IDENTITY_SESSION_SECRET = "TestSecretValue_With-Numbers123!AndSymbols@2026";
}

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { RequestAuthContext } from "../auth/request-context";
import { InstanceSettingsStore } from "../storage/instance-settings-store";
import { InstanceSettingsService } from "../settings/instance-settings-service";
import { handleInstanceSettingsApi, type InstanceSettingsRoutesContext } from "./instance-settings-routes";

const authContext: RequestAuthContext = {
  npub: "npub1admin",
  actorNpub: "npub1admin",
  session: null,
  delegatedByBot: false,
};

const makeTempDb = () => join(tmpdir(), `instance-settings-routes-${randomUUID()}.sqlite`);

describe("handleInstanceSettingsApi", () => {
  let dbPath: string;
  let store: InstanceSettingsStore;
  let service: InstanceSettingsService;
  let ctx: InstanceSettingsRoutesContext;

  beforeEach(() => {
    dbPath = makeTempDb();
    store = new InstanceSettingsStore(dbPath);
    service = new InstanceSettingsService(store);
    ctx = {
      service,
      ensureApiAccess: async () => null,
      AccessActions: { SystemManage: "system:manage" as any },
    };
  });

  afterEach(() => {
    store.close();
    rmSync(dbPath, { force: true });
  });

  test("returns null for unrelated routes", async () => {
    const url = new URL("http://localhost/api/config");
    const response = await handleInstanceSettingsApi(new Request(url.toString()), url, "GET", authContext, ctx);

    expect(response).toBeNull();
  });

  test("lists masked settings and env import candidates", async () => {
    const original = process.env.GITEA_API_TOKEN;
    process.env.GITEA_API_TOKEN = "secret-token-value";
    try {
      const url = new URL("http://localhost/api/instance-settings");
      const response = await handleInstanceSettingsApi(new Request(url.toString()), url, "GET", authContext, ctx);
      const body = await response!.json() as {
        candidates: Array<{ key: string; maskedEnvValue: string }>;
      };

      const candidate = body.candidates.find((item) => item.key === "integrations.gitea_api_token");
      expect(response!.status).toBe(200);
      expect(candidate?.maskedEnvValue).toBe("secr..alue");
    } finally {
      if (original === undefined) delete process.env.GITEA_API_TOKEN;
      else process.env.GITEA_API_TOKEN = original;
    }
  });

  test("exposes the editable ACP permission default to the settings UI", async () => {
    const url = new URL("http://localhost/api/instance-settings");
    const response = await handleInstanceSettingsApi(new Request(url.toString()), url, "GET", authContext, ctx);
    const body = await response!.json() as {
      settings: Array<{ key: string; defaultValue: string; options: string[] }>;
    };
    expect(body.settings.find((setting) => setting.key === "agents.acp_permission_policy"))
      .toMatchObject({ defaultValue: "auto_approve", options: ["auto_approve", "ask"] });
  });

  test("imports selected env settings without echoing secret values", async () => {
    const original = process.env.GITEA_API_TOKEN;
    process.env.GITEA_API_TOKEN = "secret-token-value";
    try {
      const url = new URL("http://localhost/api/instance-settings/import");
      const request = new Request(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys: ["integrations.gitea_api_token"] }),
      });
      const response = await handleInstanceSettingsApi(request, url, "POST", authContext, ctx);
      const body = await response!.json() as { imported: string[] };

      expect(response!.status).toBe(200);
      expect(body.imported).toEqual(["integrations.gitea_api_token"]);
      expect(JSON.stringify(body)).not.toContain("secret-token-value");
      expect(store.get("integrations.gitea_api_token")).toBe("secret-token-value");
    } finally {
      if (original === undefined) delete process.env.GITEA_API_TOKEN;
      else process.env.GITEA_API_TOKEN = original;
    }
  });

  test("returns access denial before reading settings", async () => {
    const denied = Response.json({ error: "admin-only" }, { status: 403 });
    ctx.ensureApiAccess = async () => denied;
    const url = new URL("http://localhost/api/instance-settings");
    const response = await handleInstanceSettingsApi(new Request(url.toString()), url, "GET", authContext, ctx);
    const body = await response!.json() as { error: string };

    expect(response!.status).toBe(403);
    expect(body.error).toBe("admin-only");
  });

  test("round-trips normalized model provider settings and rejects malformed updates", async () => {
    const url = new URL("http://localhost/api/instance-settings/models.providers");
    const validRequest = new Request(url.toString(), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        value: JSON.stringify({
          providers: {
            openrouter: { models: [" qwen/qwen3.7-flash ", "qwen/qwen3.7-flash"] },
          },
        }),
      }),
    });
    const validResponse = await handleInstanceSettingsApi(validRequest, url, "PUT", authContext, ctx);
    expect(validResponse!.status).toBe(200);
    const persisted = store.get("models.providers");
    expect(persisted).not.toBeNull();
    expect(JSON.parse(persisted!)).toEqual({
      providers: { openrouter: { models: ["qwen/qwen3.7-flash"] } },
    });

    const invalidRequest = new Request(url.toString(), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        value: JSON.stringify({ providers: { openrouter: { models: ["broken"] } } }),
      }),
    });
    const invalidResponse = await handleInstanceSettingsApi(invalidRequest, url, "PUT", authContext, ctx);
    expect(invalidResponse!.status).toBe(400);
    expect(store.get("models.providers")).toBe(persisted);

    const listUrl = new URL("http://localhost/api/instance-settings");
    const listResponse = await handleInstanceSettingsApi(
      new Request(listUrl.toString()),
      listUrl,
      "GET",
      authContext,
      ctx,
    );
    const body = await listResponse!.json() as { settings: Array<{ key: string; value: string }> };
    const listedSetting = body.settings.find((setting) => setting.key === "models.providers");
    expect(listedSetting).toBeDefined();
    expect(listedSetting!.value).toBe(persisted!);
  });
});

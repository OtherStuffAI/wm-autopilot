import { describe, expect, test } from "bun:test";

import type { RequestAuthContext } from "../auth/request-context";
import { handleUserSettingsApi, type UserSettingsRoutesContext } from "./user-settings-routes";

const authedContext: RequestAuthContext = {
  npub: "npub1viewer",
  actorNpub: "npub1viewer",
  session: null,
  delegatedByBot: false,
};

const anonymousContext: RequestAuthContext = {
  npub: null,
  actorNpub: null,
  session: null,
  delegatedByBot: false,
};

function createContext(options: {
  settings?: Record<string, string>;
  onSet?: (npub: string, key: string, value: string) => void;
  onDelete?: (npub: string, key: string) => void;
  deniedResponse?: Response | null;
} = {}): UserSettingsRoutesContext {
  const settings = options.settings ?? {};

  return {
    agents: {
      claude: { label: "Claude" },
      codex: { label: "Codex" },
      pi: { label: "Pi" },
    },
    userSettingsStore: {
      getAll: () => settings,
      set: (npub, key, value) => {
        options.onSet?.(npub, key, value);
      },
      delete: (npub, key) => {
        options.onDelete?.(npub, key);
      },
    },
    ensureApiAccess: async () => options.deniedResponse ?? null,
    AccessActions: {
      SessionsManage: "sessions:manage" as any,
    },
  };
}

async function callUserSettingsRoute(
  path: string,
  method: "GET" | "PUT" | "DELETE" | "POST" = "GET",
  options: {
    body?: string;
    authContext?: RequestAuthContext;
    ctx?: UserSettingsRoutesContext;
  } = {},
): Promise<Response | null> {
  const url = new URL(`http://localhost:3000${path}`);
  const request = new Request(url.toString(), {
    method,
    headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: options.body,
  });
  return handleUserSettingsApi(
    request,
    url,
    method,
    options.authContext ?? authedContext,
    options.ctx ?? createContext(),
  );
}

describe("handleUserSettingsApi", () => {
  test("ignores unrelated API paths", async () => {
    const response = await callUserSettingsRoute("/api/config");

    expect(response).toBeNull();
  });

  test("returns masked settings for the authenticated viewer", async () => {
    const ctx = createContext({
      settings: {
        speech_api_key: "test-speech-key",
        openai_token: "short",
        theme: "dark",
        password_hint: "abcdefgh",
      },
    });

    const response = await callUserSettingsRoute("/api/user/settings", "GET", { ctx });
    const body = await response!.json() as { settings: Record<string, string> };

    expect(response!.status).toBe(200);
    expect(body.settings).toEqual({
      speech_api_key: "test..-key",
      openai_token: "****",
      theme: "dark",
      password_hint: "****",
    });
  });

  test("requires an authenticated viewer after access passes", async () => {
    const response = await callUserSettingsRoute("/api/user/settings", "GET", {
      authContext: anonymousContext,
    });
    const body = await response!.json() as { error: string };

    expect(response!.status).toBe(401);
    expect(body).toEqual({ error: "Authentication required" });
  });

  test("normalizes and saves a valid default_agent setting", async () => {
    const saved: Array<{ npub: string; key: string; value: string }> = [];
    const ctx = createContext({
      onSet: (npub, key, value) => saved.push({ npub, key, value }),
    });

    const response = await callUserSettingsRoute("/api/user/settings/default_agent", "PUT", {
      ctx,
      body: JSON.stringify({ value: " Pi " }),
    });
    const body = await response!.json() as { success: boolean; key: string; value: string };

    expect(response!.status).toBe(200);
    expect(body).toEqual({ success: true, key: "default_agent", value: "pi" });
    expect(saved).toEqual([{ npub: "npub1viewer", key: "default_agent", value: "pi" }]);
  });

  test("rejects an unsupported default_agent setting without persisting", async () => {
    const saved: Array<{ npub: string; key: string; value: string }> = [];
    const ctx = createContext({
      onSet: (npub, key, value) => saved.push({ npub, key, value }),
    });

    const response = await callUserSettingsRoute("/api/user/settings/default_agent", "PUT", {
      ctx,
      body: JSON.stringify({ value: "unknown-agent" }),
    });
    const body = await response!.json() as { error: string };

    expect(response!.status).toBe(400);
    expect(body.error).toContain("claude");
    expect(body.error).toContain("pi");
    expect(saved).toEqual([]);
  });

  test("rejects invalid JSON payloads", async () => {
    const response = await callUserSettingsRoute("/api/user/settings/speech_model", "PUT", {
      body: "{invalid",
    });
    const body = await response!.json() as { error: string };

    expect(response!.status).toBe(400);
    expect(body).toEqual({ error: "Invalid JSON" });
  });

  test("rejects a blank value", async () => {
    const response = await callUserSettingsRoute("/api/user/settings/speech_model", "PUT", {
      body: JSON.stringify({ value: "   " }),
    });
    const body = await response!.json() as { error: string };

    expect(response!.status).toBe(400);
    expect(body).toEqual({ error: "value is required" });
  });

  test("saves non-default settings without echoing the value", async () => {
    const saved: Array<{ npub: string; key: string; value: string }> = [];
    const ctx = createContext({
      onSet: (npub, key, value) => saved.push({ npub, key, value }),
    });

    const response = await callUserSettingsRoute("/api/user/settings/speech_model", "PUT", {
      ctx,
      body: JSON.stringify({ value: " tts-1 " }),
    });
    const body = await response!.json() as { success: boolean; key: string; value?: string };

    expect(response!.status).toBe(200);
    expect(body).toEqual({ success: true, key: "speech_model" });
    expect(saved).toEqual([{ npub: "npub1viewer", key: "speech_model", value: "tts-1" }]);
  });

  test("deletes a setting", async () => {
    const deleted: Array<{ npub: string; key: string }> = [];
    const ctx = createContext({
      onDelete: (npub, key) => deleted.push({ npub, key }),
    });

    const response = await callUserSettingsRoute("/api/user/settings/speech_model", "DELETE", { ctx });
    const body = await response!.json() as { success: boolean; key: string; deleted: boolean };

    expect(response!.status).toBe(200);
    expect(body).toEqual({ success: true, key: "speech_model", deleted: true });
    expect(deleted).toEqual([{ npub: "npub1viewer", key: "speech_model" }]);
  });

  test("returns not found for unsupported methods or missing keys", async () => {
    const postResponse = await callUserSettingsRoute("/api/user/settings/speech_model", "POST");
    const postBody = await postResponse!.json() as { error: string };
    const deleteResponse = await callUserSettingsRoute("/api/user/settings", "DELETE");
    const deleteBody = await deleteResponse!.json() as { error: string };

    expect(postResponse!.status).toBe(404);
    expect(postBody).toEqual({ error: "Not found" });
    expect(deleteResponse!.status).toBe(404);
    expect(deleteBody).toEqual({ error: "Not found" });
  });

  test("short-circuits access denial before settings access", async () => {
    let settingsRead = false;
    const deniedResponse = Response.json({ error: "Denied" }, { status: 403 });
    const ctx = createContext({ deniedResponse });
    ctx.userSettingsStore.getAll = () => {
      settingsRead = true;
      return {};
    };

    const response = await callUserSettingsRoute("/api/user/settings", "GET", { ctx });
    const body = await response!.json() as { error: string };

    expect(response!.status).toBe(403);
    expect(body).toEqual({ error: "Denied" });
    expect(settingsRead).toBe(false);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InstanceSettingsStore } from "../storage/instance-settings-store";
import { AgentSigningModeSettings } from "./agent-signing-mode-settings";

const dbPaths: string[] = [];

function makeStore() {
  const path = join(tmpdir(), `agent-signing-mode-${randomUUID()}.sqlite`);
  dbPaths.push(path);
  return { path, store: new InstanceSettingsStore(path) };
}

afterEach(() => {
  for (const path of dbPaths.splice(0)) rmSync(path, { force: true });
});

describe("AgentSigningModeSettings", () => {
  test("defaults to standard-agent and persists UI-selected mode across store reload", () => {
    const first = makeStore();
    const settings = new AgentSigningModeSettings(first.store);
    expect(settings.snapshot()).toMatchObject({ mode: "standard-agent", configured: false });

    expect(settings.setMode("full-agent", "npub1admin")).toMatchObject({
      mode: "full-agent",
      configured: true,
      source: "app",
    });
    first.store.close();

    const reloadedStore = new InstanceSettingsStore(first.path);
    const reloaded = new AgentSigningModeSettings(reloadedStore);
    expect(reloaded.snapshot()).toMatchObject({ mode: "full-agent", configured: true });
    reloadedStore.close();
  });

  test("rejects unknown modes instead of hiding inconsistent state", () => {
    const { store } = makeStore();
    const settings = new AgentSigningModeSettings(store);
    expect(() => settings.setMode("owner", "npub1admin")).toThrow("Unknown agent signing mode");
    store.close();
  });

  test("preserves an unreadable stored mode and falls back after a session-secret rotation", () => {
    const previousSecret = process.env.IDENTITY_SESSION_SECRET;
    const { store } = makeStore();
    try {
      process.env.IDENTITY_SESSION_SECRET = "OldSecret_Value-For-Agent-Signing-Mode-123";
      const settings = new AgentSigningModeSettings(store);
      settings.setMode("full-agent", "npub1admin");

      process.env.IDENTITY_SESSION_SECRET = "NewSecret_Value-For-Agent-Signing-Mode-456";
      expect(settings.getMode()).toBe("standard-agent");
      expect(settings.snapshot()).toEqual({
        mode: "standard-agent",
        configured: false,
        updatedAt: null,
        source: null,
      });
      expect(store.has("agents.signing_mode")).toBe(true);
    } finally {
      store.close();
      if (previousSecret === undefined) delete process.env.IDENTITY_SESSION_SECRET;
      else process.env.IDENTITY_SESSION_SECRET = previousSecret;
    }
  });
});

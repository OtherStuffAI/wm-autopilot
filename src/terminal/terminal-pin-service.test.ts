if (!Bun.env.IDENTITY_SESSION_SECRET) {
  Bun.env.IDENTITY_SESSION_SECRET = "TestSecretValue_With-Numbers123!AndSymbols@2026";
}

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { InstanceSettingsStore } from "../storage/instance-settings-store";
import { InstanceSettingsService } from "../settings/instance-settings-service";
import { TERMINAL_PIN_SETTING_KEY, TerminalPinService } from "./terminal-pin-service";

describe("TerminalPinService", () => {
  let dbPath: string;
  let store: InstanceSettingsStore;
  let service: TerminalPinService;

  beforeEach(() => {
    dbPath = join(tmpdir(), `terminal-pin-${randomUUID()}.sqlite`);
    store = new InstanceSettingsStore(dbPath);
    service = new TerminalPinService(store);
  });

  afterEach(() => {
    store.close();
    rmSync(dbPath, { force: true });
  });

  test("is disabled without a stored verifier and rejects the historical fallback", () => {
    expect(service.isConfigured()).toBe(false);
    expect(service.verify("44444")).toBe(false);
  });

  test("stores only an encrypted one-way verifier and verifies the original PIN", () => {
    service.setPin("12345");

    expect(service.isConfigured()).toBe(true);
    expect(service.verify("12345")).toBe(true);
    expect(service.verify("44444")).toBe(false);

    const db = new Database(dbPath, { readonly: true });
    const row = db.query<{ value: string }, [string]>(
      "SELECT value FROM instance_settings WHERE key = ?1",
    ).get(TERMINAL_PIN_SETTING_KEY);
    db.close();
    expect(row?.value.startsWith("enc::")).toBe(true);
    expect(row?.value).not.toContain("12345");

    const settingsPayload = JSON.stringify(new InstanceSettingsService(store).listMaskedSettings({}));
    expect(settingsPayload).not.toContain(TERMINAL_PIN_SETTING_KEY);
    expect(settingsPayload).not.toContain("verifier");
    expect(settingsPayload).not.toContain("12345");
  });

  test("replacement stops the old PIN", () => {
    service.setPin("12345");
    service.setPin("67890");

    expect(service.verify("12345")).toBe(false);
    expect(service.verify("67890")).toBe(true);
  });

  test("requires exactly five digits", () => {
    expect(() => service.setPin("1234")).toThrow("exactly 5 digits");
    expect(() => service.setPin("abcde")).toThrow("exactly 5 digits");
  });
});

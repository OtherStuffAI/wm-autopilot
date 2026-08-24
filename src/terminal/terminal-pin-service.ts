import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import type { InstanceSettingsStore } from "../storage/instance-settings-store";

export const TERMINAL_PIN_SETTING_KEY = "terminal.pin_verifier";
const VERIFIER_VERSION = 1;
const SALT_BYTES = 16;
const VERIFIER_BYTES = 32;

interface TerminalPinVerifier {
  version: 1;
  algorithm: "scrypt";
  salt: string;
  verifier: string;
}

export class TerminalPinService {
  constructor(private readonly store: InstanceSettingsStore) {}

  isConfigured(): boolean {
    return this.readVerifier() !== null;
  }

  setPin(pin: string): void {
    validateTerminalPin(pin);
    const salt = randomBytes(SALT_BYTES);
    const pinBytes = Buffer.from(pin, "utf8");
    let verifier: Buffer | null = null;
    try {
      verifier = scryptSync(pinBytes, salt, VERIFIER_BYTES);
      const payload: TerminalPinVerifier = {
        version: VERIFIER_VERSION,
        algorithm: "scrypt",
        salt: salt.toString("base64"),
        verifier: verifier.toString("base64"),
      };
      this.store.set({
        key: TERMINAL_PIN_SETTING_KEY,
        value: JSON.stringify(payload),
        valueKind: "secret",
        source: "app",
      });
    } finally {
      pinBytes.fill(0);
      salt.fill(0);
      verifier?.fill(0);
    }
  }

  verify(pin: string): boolean {
    const payload = this.readVerifier();
    if (!payload) return false;
    const salt = Buffer.from(payload.salt, "base64");
    const expected = Buffer.from(payload.verifier, "base64");
    const pinBytes = Buffer.from(pin, "utf8");
    let actual: Buffer | null = null;
    try {
      actual = scryptSync(pinBytes, salt, expected.length);
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    } catch {
      return false;
    } finally {
      pinBytes.fill(0);
      salt.fill(0);
      expected.fill(0);
      actual?.fill(0);
    }
  }

  private readVerifier(): TerminalPinVerifier | null {
    const serialized = this.store.get(TERMINAL_PIN_SETTING_KEY);
    if (!serialized) return null;
    try {
      const parsed = JSON.parse(serialized) as Partial<TerminalPinVerifier>;
      if (
        parsed.version !== VERIFIER_VERSION ||
        parsed.algorithm !== "scrypt" ||
        typeof parsed.salt !== "string" ||
        typeof parsed.verifier !== "string" ||
        Buffer.from(parsed.salt, "base64").length !== SALT_BYTES ||
        Buffer.from(parsed.verifier, "base64").length !== VERIFIER_BYTES
      ) {
        return null;
      }
      return parsed as TerminalPinVerifier;
    } catch {
      return null;
    }
  }
}

export function validateTerminalPin(pin: string): void {
  if (!/^\d{5}$/.test(pin)) {
    throw new Error("Terminal PIN must be exactly 5 digits");
  }
}

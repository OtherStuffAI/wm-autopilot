import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PersistedCapabilityRecord } from "./capability-broker";
import { FileCapabilityBrokerStateStore } from "./capability-state-store";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("FileCapabilityBrokerStateStore", () => {
  test("atomically round-trips verifier state without a bearer token", () => {
    const directory = mkdtempSync(join(tmpdir(), "wingman-capability-state-"));
    directories.push(directory);
    const path = join(directory, "state.json");
    const store = new FileCapabilityBrokerStateStore(path);
    const record: PersistedCapabilityRecord = {
      id: "capability-a",
      tokenHash: "ab".repeat(32),
      issuedAtMs: 1,
      expiresAtMs: 2,
      sessionId: "session-a",
      ownerNpub: "npub1owner",
      botNpub: "npub1bot",
      botPubkeyHex: "cd".repeat(32),
      policy: { operations: ["identity.read"] },
      revokedAtMs: null,
      usedNonces: ["nonce-abcdefghijkl"],
      callTimestamps: [1],
      spentMsats: 0,
    };

    store.save([record]);
    expect(store.load()).toEqual([record]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).not.toContain("wmcap_v1.");
  });
});

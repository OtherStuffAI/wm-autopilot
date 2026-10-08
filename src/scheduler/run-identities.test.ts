import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotKeyStore } from "../identity/bot-key-store";
import { listSchedulerRunIdentities } from "./run-identities";

test("lists all owned active keys with profile names, excluding foreign and retired keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "trigger-identities-"));
  try {
    const keys = new BotKeyStore(join(dir, "keys.db"));
    for (const [botNpub, userNpub] of [["npub-rick", "owner"], ["npub-legacy", "owner"], ["npub-retired", "owner"], ["npub-foreign", "other"]]) {
      keys.createKey({ userNpub, botNpub, botPubkeyHex: botNpub, displayName: "Legacy bot", encryptedToUser: "encrypted", encryptedEscrow: "encrypted", escrowUuid: "uuid" });
    }
    keys.deactivateKey(keys.getActiveKeyForBotNpub("npub-retired")!.id);
    expect(listSchedulerRunIdentities("owner", keys, [{ botNpub: "npub-rick", label: "Rick", enabled: true }, { botNpub: "npub-legacy", label: "Disabled", enabled: false }])).toEqual([
      { botNpub: "npub-rick", name: "Rick" },
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import { join } from "node:path";
import { createHash } from "node:crypto";
import { nip19 } from "nostr-tools";

import type { BotKeyRecord } from "../identity/bot-key-store";
import { BrokerKeyVault, type BrokerKeyVaultBackend } from "../signing/broker-key-vault";

function recordFor(input: { id: string; ownerNpub: string; npub: string; pending?: boolean }): BotKeyRecord {
  const decoded = nip19.decode(input.npub);
  if (decoded.type !== "npub" || typeof decoded.data !== "string") throw new Error("WApp publisher npub is invalid");
  return {
    id: `wapp-${input.pending ? "pending" : "active"}-${createHash("sha256").update(input.id).digest("hex")}`,
    userNpub: input.ownerNpub,
    botPubkeyHex: decoded.data,
    botNpub: input.npub,
    displayName: "WApp publisher",
    encryptedToUser: "",
    encryptedEscrow: "",
    escrowUuid: "",
    isActive: 1,
    createdAt: "",
    updatedAt: "",
  };
}

/** Callback-only custody for WApp publisher identities. */
export class WappSigningBroker {
  constructor(private readonly vault: BrokerKeyVaultBackend = new BrokerKeyVault()) {}

  static forDataDirectory(dataDir: string): WappSigningBroker {
    return new WappSigningBroker(new BrokerKeyVault({
      masterKeyPath: join(dataDir, "broker-vault", "master.key"),
      envelopesDirectory: join(dataDir, "broker-vault", "wapps"),
    }));
  }

  has(input: { id: string; ownerNpub: string; npub: string; pending?: boolean }): boolean {
    return this.vault.has(recordFor(input));
  }

  provision(input: { id: string; ownerNpub: string; npub: string; nsec: string; pending?: boolean }): void {
    const decoded = nip19.decode(input.nsec);
    if (decoded.type !== "nsec" || !(decoded.data instanceof Uint8Array)) throw new Error("WApp publisher key is invalid");
    const secret = new Uint8Array(decoded.data);
    try { this.vault.provision(recordFor(input), secret); } finally { secret.fill(0); }
  }

  async withNsec<T>(
    input: { id: string; ownerNpub: string; npub: string; pending?: boolean },
    operation: (nsec: string) => T | Promise<T>,
  ): Promise<T> {
    return await this.vault.withKey(recordFor(input), async (secret) => {
      const nsec = nip19.nsecEncode(secret);
      return await operation(nsec);
    });
  }
}

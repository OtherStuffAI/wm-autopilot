import type { BotKeyRecord } from "../identity/bot-key-store";
import { unlockViaEscrow, unlockViaEscrowWithSecret } from "../identity/bot-key-manager";
import type { WingmanInstanceIdentity } from "../identity/wingman-instance-identity";
import type { BrokerKeyVaultBackend } from "./broker-key-vault";

/**
 * Rewrap one legacy stable-agent record into the broker vault.
 *
 * Older installations commonly used the same control-process identity under
 * the retired KEYTELEPORT_PRIVKEY name and today's WINGMAN_PRIV name. Try the
 * retired setting first, then the current instance identity strictly as a
 * one-time compatibility unwrap. The vault validates the resulting agent
 * pubkey before persisting it.
 */
export function ensureLegacyBrokerRecordProvisioned(input: {
  vault: BrokerKeyVaultBackend;
  record: BotKeyRecord;
  instanceIdentity: WingmanInstanceIdentity | null;
}): void {
  input.vault.ensureProvisioned(input.record, (record) => {
    try {
      return unlockViaEscrow(record.encryptedEscrow, record.botPubkeyHex, record.escrowUuid);
    } catch (legacyError) {
      if (!input.instanceIdentity) throw legacyError;
      return unlockViaEscrowWithSecret(
        record.encryptedEscrow,
        record.botPubkeyHex,
        record.escrowUuid,
        input.instanceIdentity.secretKey,
      );
    }
  });
}

import type { WingmanInstanceIdentity } from '../identity/wingman-instance-identity';
import { unlockViaEscrow } from '../identity/bot-key-manager';
import { BrokerKeyNotProvisionedError, type BrokerKeyVaultBackend } from '../signing/broker-key-vault';
import type { BotKeyStoreRecord, RuntimeBotIdentity } from './types';

interface SubscriptionBotIdentityDependencies {
  instanceIdentity: WingmanInstanceIdentity | null;
  brokerKeyVault?: Pick<BrokerKeyVaultBackend, 'withKey'>;
}

function hasLegacyEscrow(record: BotKeyStoreRecord): boolean {
  return record.encryptedEscrow.trim().length > 0 && record.escrowUuid.trim().length > 0;
}

export function createSubscriptionBotIdentityResolver(deps: SubscriptionBotIdentityDependencies) {
  return async function resolveSubscriptionBotIdentity(record: BotKeyStoreRecord): Promise<RuntimeBotIdentity> {
    if (record.botNpub === deps.instanceIdentity?.npub) {
      return {
        botNpub: deps.instanceIdentity.npub,
        botPubkeyHex: deps.instanceIdentity.pubkeyHex,
        botSecret: deps.instanceIdentity.secretKey,
      };
    }

    if (deps.brokerKeyVault) {
      return deps.brokerKeyVault.withKey(record, (secretKey) => ({
        botNpub: record.botNpub,
        botPubkeyHex: record.botPubkeyHex,
        // The vault wipes its callback buffer. Runtime owns this bounded copy
        // until the subscription is replaced or stopped, where it is wiped.
        botSecret: new Uint8Array(secretKey),
      }));
    }

    if (!hasLegacyEscrow(record)) {
      throw new BrokerKeyNotProvisionedError(record.userNpub, record.botNpub);
    }

    return {
      botNpub: record.botNpub,
      botPubkeyHex: record.botPubkeyHex,
      botSecret: unlockViaEscrow(record.encryptedEscrow, record.botPubkeyHex, record.escrowUuid),
    };
  };
}

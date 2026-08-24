import type { WingmanInstanceIdentity } from '../identity/wingman-instance-identity';
import type { BrokerKeyVaultBackend } from '../signing/broker-key-vault';
import type { AgentDefinitionRecord, BotKeyStoreRecord, RuntimeBotIdentity } from './types';

interface ProfileBotIdentityDependencies {
  instanceIdentity: WingmanInstanceIdentity | null;
  botKeyStore: {
    getActiveKeyForBotNpub: (botNpub: string) => BotKeyStoreRecord | null;
  };
  brokerKeyVault: Pick<BrokerKeyVaultBackend, 'withKey'>;
}

export function createProfileBotIdentityRunner(deps: ProfileBotIdentityDependencies) {
  return async function withProfileBotIdentity<T>(
    agent: AgentDefinitionRecord,
    operation: (identity: RuntimeBotIdentity) => Promise<T>,
  ): Promise<T> {
    if (agent.botNpub === deps.instanceIdentity?.npub) {
      return operation({
        botNpub: deps.instanceIdentity.npub,
        botPubkeyHex: deps.instanceIdentity.pubkeyHex,
        botSecret: deps.instanceIdentity.secretKey,
      });
    }
    const record = deps.botKeyStore.getActiveKeyForBotNpub(agent.botNpub);
    if (!record || record.userNpub !== agent.managedByNpub) {
      throw new Error(`Agent identity binding is unavailable for ${agent.agentId}.`);
    }
    return deps.brokerKeyVault.withKey(record, (secretKey) => operation({
      botNpub: record.botNpub,
      botPubkeyHex: record.botPubkeyHex,
      botSecret: secretKey,
    }));
  };
}

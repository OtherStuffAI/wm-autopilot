import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

import { getBotDisplayName, signBotProfileEvent, type SignedNostrEvent } from './bot-identity-publisher';

export interface BrokeredAgentIdentity {
  botPubkeyHex: string;
  botNpub: string;
  displayName: string;
  signedProfileEvent: SignedNostrEvent;
}

/**
 * Creates and provisions a sovereign agent identity without producing a raw
 * key representation. The temporary secret is owned and wiped here.
 */
export function createBrokeredAgentIdentity(input: {
  profile?: { name?: string | null; picture?: string | null; about?: string | null; nip05?: string | null };
  provision: (identity: BrokeredAgentIdentity, secretKey: Uint8Array) => void;
}): BrokeredAgentIdentity {
  const secretKey = generateSecretKey();
  try {
    const botPubkeyHex = getPublicKey(secretKey);
    const displayName = input.profile?.name?.trim() || getBotDisplayName(botPubkeyHex);
    const identity: BrokeredAgentIdentity = {
      botPubkeyHex,
      botNpub: nip19.npubEncode(botPubkeyHex),
      displayName,
      signedProfileEvent: signBotProfileEvent(secretKey, displayName, input.profile),
    };
    input.provision(identity, secretKey);
    return identity;
  } finally {
    secretKey.fill(0);
  }
}

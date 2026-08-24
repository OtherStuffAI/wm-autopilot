import { SimplePool, nip19 } from 'nostr-tools';

import {
  SBIP0009_ACCESS_GRANT_KIND,
  type AccessGrantSubscriptionManager,
  type NostrAccessGrantEvent,
  processAccessGrantEvent,
} from '../access-grants/sbip0009';

export interface AccessGrantListener {
  subscribe(managedByNpub: string, recipientSecretKey: Uint8Array, recipientPubkeyHex: string): void;
  unsubscribe(recipientPubkeyHex: string): void;
  shutdown(): void;
}

export interface AccessGrantListenerDeps {
  relays: string[];
  subscriptionManager: AccessGrantSubscriptionManager;
  pool?: AccessGrantRelayPool;
  replayTimeoutMs?: number;
  isAuthorizedIssuerNpub?: (npub: string) => boolean;
}

interface AccessGrantRelayPool {
  querySync(
    relays: string[],
    filter: Record<string, unknown>,
    params?: { maxWait?: number },
  ): Promise<NostrAccessGrantEvent[]>;
  subscribe(
    relays: string[],
    filter: Record<string, unknown>,
    params: {
      onevent(event: NostrAccessGrantEvent): void;
      oneose?(): void;
    },
  ): { close(): void };
  close(relays: string[]): void;
}

export function createAccessGrantListener(deps: AccessGrantListenerDeps): AccessGrantListener {
  const pool = deps.pool ?? new SimplePool() as AccessGrantRelayPool;
  const subscriptions = new Map<string, { close: () => void }>();
  const processedKeys = new Set<string>();

  function recipientNpubFromHex(pubkeyHex: string): string {
    return nip19.npubEncode(pubkeyHex);
  }

  return {
    subscribe(managedByNpub, recipientSecretKey, recipientPubkeyHex) {
      const normalizedHex = recipientPubkeyHex.toLowerCase();
      if (subscriptions.has(normalizedHex)) return;
      if (deps.relays.length === 0) {
        console.warn('[onboarding-33357] No relays configured, skipping onboarding subscription');
        return;
      }
      const recipientNpub = recipientNpubFromHex(normalizedHex);
      const filter = {
        kinds: [SBIP0009_ACCESS_GRANT_KIND],
        '#p': [normalizedHex],
      };
      let closed = false;
      let liveSub: { close(): void } | null = null;
      const state = {
        close: () => {
          closed = true;
          liveSub?.close();
        },
      };
      subscriptions.set(normalizedHex, state);

      const handleEvent = (event: NostrAccessGrantEvent) => {
        processAccessGrantEvent({
          event,
          recipientSecretKey,
          recipientNpub,
          managedByNpub,
          subscriptionManager: deps.subscriptionManager,
          processedKeys,
          isAuthorizedIssuerNpub: deps.isAuthorizedIssuerNpub,
        }).then((result) => {
          const id = event.id?.slice(0, 12) ?? 'unknown';
          if (result.ok) {
            console.log(`[onboarding-33357] ${result.code} for event ${id}`);
          } else {
            console.warn(`[onboarding-33357] ${result.code} for event ${id}: ${result.message}`);
          }
        }).catch((error) => {
          console.error('[onboarding-33357] Failed to process onboarding event:', error);
        });
      };

      void pool.querySync(deps.relays, filter, { maxWait: deps.replayTimeoutMs ?? 5000 })
        .then((events) => {
          for (const event of events) handleEvent(event);
        })
        .catch((error) => {
          console.warn('[onboarding-33357] Initial access-grant replay failed:', error);
        })
        .finally(() => {
          if (closed) return;
          liveSub = pool.subscribe(deps.relays, filter, {
            onevent: handleEvent,
            oneose() {
              console.log(`[onboarding-33357] Listening for onboarding events for ${normalizedHex.slice(0, 12)}...`);
            },
          });
        });
    },
    unsubscribe(recipientPubkeyHex) {
      const normalizedHex = recipientPubkeyHex.toLowerCase();
      const sub = subscriptions.get(normalizedHex);
      if (!sub) return;
      sub.close();
      subscriptions.delete(normalizedHex);
    },
    shutdown() {
      for (const sub of subscriptions.values()) sub.close();
      subscriptions.clear();
      pool.close(deps.relays);
    },
  };
}

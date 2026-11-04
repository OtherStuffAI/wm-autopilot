import { loadYokeBotHelpers } from './yoke-bot-helpers';
import type { RuntimeBotIdentity } from './types';
import type { FlightDeckPgBotIdentity } from './tower-client';

/**
 * Resolves the subscription's current signing identity, or null when the
 * subscription was removed, revoked, inactive, or now belongs to a different bot.
 */
export type LiveSubscriptionIdentityResolver = (subscriptionId: string, botNpub: string) => RuntimeBotIdentity | null;

let liveResolver: LiveSubscriptionIdentityResolver | null = null;

export function setLiveSubscriptionIdentityResolver(resolver: LiveSubscriptionIdentityResolver | null): void {
  liveResolver = resolver;
}

export class AgentActivityIdentityUnavailableError extends Error {
  constructor(subscriptionId: string, reason = 'no longer has a live signing identity for this activity') {
    super(`Subscription ${subscriptionId} ${reason}`);
    this.name = 'AgentActivityIdentityUnavailableError';
  }
}

/**
 * Subscription-bound activity signs through the subscription's live identity:
 * identity refresh zeroes the previous secret buffer, so a captured copy goes
 * stale mid-turn. The live lookup happens inside the signing call, after the
 * async Tower URL preparation, so a refresh cannot slip in between lookup and
 * signature. Unavailable (removed, revoked, other bot, no resolver installed)
 * always throws; there is no fallback to the captured or another identity.
 * Contexts without a subscription (profile identities) keep their own identity.
 */
export function resolveActivitySigner(context: { subscriptionId?: string | null; botIdentity: RuntimeBotIdentity }): FlightDeckPgBotIdentity {
  const { subscriptionId, botIdentity } = context;
  if (!subscriptionId || 'signNip98' in botIdentity) return botIdentity;
  const liveIdentity = (): RuntimeBotIdentity => {
    if (!liveResolver) throw new AgentActivityIdentityUnavailableError(subscriptionId, 'has no live identity resolver installed');
    const live = liveResolver(subscriptionId, botIdentity.botNpub);
    if (!live) throw new AgentActivityIdentityUnavailableError(subscriptionId);
    return live;
  };
  liveIdentity();
  return {
    botNpub: botIdentity.botNpub,
    botPubkeyHex: botIdentity.botPubkeyHex,
    towerTransport: (botIdentity as Pick<FlightDeckPgBotIdentity, 'towerTransport'>).towerTransport,
    signNip98: async ({ url, method, body }) => {
      const helpers = await loadYokeBotHelpers();
      const live = liveIdentity();
      return helpers.signBotRequest({ botSecret: live.botSecret, botNpub: live.botNpub, url, method, body: body ?? null });
    },
    signNostrEvent: async () => { throw new Error('Activity signing does not sign Nostr events'); },
  };
}

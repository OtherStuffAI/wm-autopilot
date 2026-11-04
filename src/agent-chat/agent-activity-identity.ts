import type { RuntimeBotIdentity } from './types';

/**
 * Resolves the subscription's current signing identity, or null when the
 * subscription was removed, is inactive, or now belongs to a different bot.
 */
export type LiveSubscriptionIdentityResolver = (subscriptionId: string, botNpub: string) => RuntimeBotIdentity | null;

let liveResolver: LiveSubscriptionIdentityResolver | null = null;

export function setLiveSubscriptionIdentityResolver(resolver: LiveSubscriptionIdentityResolver | null): void {
  liveResolver = resolver;
}

export class AgentActivityIdentityUnavailableError extends Error {
  constructor(subscriptionId: string) {
    super(`Subscription ${subscriptionId} no longer has a live signing identity for this activity`);
    this.name = 'AgentActivityIdentityUnavailableError';
  }
}

/**
 * Subscription-bound activity must sign with the subscription's live identity:
 * identity refresh zeroes the previous secret buffer, so a captured copy goes
 * stale mid-turn. Contexts without a subscription (profile identities) keep
 * the identity they were created with. Never falls back to another identity.
 */
export function resolveActivitySigner(context: { subscriptionId?: string | null; botIdentity: RuntimeBotIdentity }): RuntimeBotIdentity {
  if (!context.subscriptionId || !liveResolver) return context.botIdentity;
  const live = liveResolver(context.subscriptionId, context.botIdentity.botNpub);
  if (!live) throw new AgentActivityIdentityUnavailableError(context.subscriptionId);
  return live;
}

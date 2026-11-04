import { setLiveSubscriptionIdentityResolver } from './agent-activity-identity';

/** Test suites that stub Tower delivery: let any subscription resolve to a placeholder identity. */
export function installPlaceholderLiveIdentityResolver(): void {
  setLiveSubscriptionIdentityResolver((_subscriptionId, botNpub) =>
    ({ botNpub, botPubkeyHex: '00', botSecret: new Uint8Array([1]) }));
}

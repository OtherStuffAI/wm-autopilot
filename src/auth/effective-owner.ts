import type { RequestAuthContext } from "./request-context";
import { normaliseNpub } from "../identity/npub-utils";

export function getEffectiveOwnerNpub(authContext: RequestAuthContext): string | null {
  return normaliseNpub(
    authContext.delegatedOwnerNpub ??
      authContext.targetOwnerNpub ??
      authContext.npub ??
      null,
  );
}

export function getEffectiveOwnerAuthContext(authContext: RequestAuthContext): RequestAuthContext {
  const ownerNpub = getEffectiveOwnerNpub(authContext);
  if (!ownerNpub) {
    return authContext;
  }

  const currentNpub = normaliseNpub(authContext.npub ?? null);
  const currentTargetOwnerNpub = normaliseNpub(authContext.targetOwnerNpub ?? null);
  if (currentNpub === ownerNpub && currentTargetOwnerNpub === ownerNpub) {
    return authContext;
  }

  return {
    ...authContext,
    npub: ownerNpub,
    targetOwnerNpub: ownerNpub,
  };
}

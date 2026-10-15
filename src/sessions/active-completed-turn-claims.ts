interface ActiveCompletedTurnClaim {
  receiptId: string;
  claimToken: string;
}

const activeClaims = new Map<string, ActiveCompletedTurnClaim>();

function claimKey(storeKey: string, sessionId: string): string {
  return JSON.stringify([storeKey, sessionId]);
}

/** In-process proof that this host is still awaiting the exact native sender. */
export function registerActiveCompletedTurnClaim(
  storeKey: string,
  sessionId: string,
  receiptId: string,
  claimToken: string,
): () => void {
  const key = claimKey(storeKey, sessionId);
  if (activeClaims.has(key)) throw new Error("Completed-turn sender already active");
  const claim = { receiptId, claimToken };
  activeClaims.set(key, claim);
  return function releaseActiveCompletedTurnClaim(): void {
    if (activeClaims.get(key) === claim) activeClaims.delete(key);
  };
}

export function activeCompletedTurnClaim(
  storeKey: string,
  sessionId: string,
): ActiveCompletedTurnClaim | null {
  return activeClaims.get(claimKey(storeKey, sessionId)) ?? null;
}

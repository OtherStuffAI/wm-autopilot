export interface AutosessionCleanupRoutes {
  collectionPath: string;
  sessionPath: (sessionId: string) => string;
}

export function buildAutosessionCleanupRoutes(ownerNpub?: string): AutosessionCleanupRoutes {
  const normalizedOwner = ownerNpub?.trim();
  const collectionPath = normalizedOwner
    ? `/api/owners/${encodeURIComponent(normalizedOwner)}/sessions`
    : "/api/sessions";

  return {
    collectionPath,
    sessionPath: (sessionId: string) =>
      `${collectionPath}/${encodeURIComponent(sessionId)}`,
  };
}

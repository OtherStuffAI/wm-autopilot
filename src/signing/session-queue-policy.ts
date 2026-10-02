/** Exact queue authority applies even to broad presets and previously issued capabilities. */
export function permitsSessionQueueSigning(pathname: string, method: string, sessionId: string, bodyHash?: string): boolean {
  const queuePath = pathname.match(/^\/api\/(?:owners\/[^/]+\/)?sessions\/([^/]+)\/queue(?:\/(.*))?$/);
  if (!queuePath) return true;
  const selfPath = `/api/sessions/${encodeURIComponent(sessionId)}/queue`;
  return (pathname === selfPath && method === "GET")
    || (pathname.startsWith(`${selfPath}/`) && /^[^/]+\/(?:acknowledge|reconcile)$/.test(queuePath[2] ?? "") && method === "POST" && Boolean(bodyHash));
}

export function isSessionQueueSigningPath(pathname: string): boolean {
  return /^\/api\/(?:owners\/[^/]+\/)?sessions\/[^/]+\/queue(?:\/.*)?$/.test(pathname);
}

export function containsSessionQueueAuthTarget(tags: string[][]): boolean {
  return tags.some((tag) => {
    if (tag[0] !== "u" || !tag[1]) return false;
    try { return isSessionQueueSigningPath(new URL(tag[1]).pathname); } catch { return false; }
  });
}

export function resolveSessionOwnerNpub(session) {
  if (!session || typeof session !== 'object') {
    return null;
  }

  const ownerNpub =
    typeof session.ownerNpub === 'string' && session.ownerNpub.trim().length > 0
      ? session.ownerNpub.trim()
      : typeof session?.metadata?.ownerNpub === 'string' && session.metadata.ownerNpub.trim().length > 0
        ? session.metadata.ownerNpub.trim()
        : typeof session.npub === 'string' && session.npub.trim().length > 0
          ? session.npub.trim()
          : null;

  return ownerNpub;
}

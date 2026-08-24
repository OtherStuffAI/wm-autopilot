import { normaliseNpub } from "../identity/npub-utils";
import type { SessionMetadata } from "./session-metadata";

type SessionMetadataOwnerLike = Pick<SessionMetadata, "ownerNpub"> | null | undefined;

export function resolveSessionOwnerNpub(
  sessionNpub: string | null | undefined,
  metadata?: SessionMetadataOwnerLike,
): string | null {
  const metadataOwnerNpub =
    metadata && typeof metadata.ownerNpub === "string"
      ? normaliseNpub(metadata.ownerNpub)
      : null;
  if (metadataOwnerNpub) {
    return metadataOwnerNpub;
  }
  return normaliseNpub(sessionNpub ?? null);
}

export function sessionBelongsToViewer(
  sessionNpub: string | null | undefined,
  metadata: SessionMetadataOwnerLike,
  viewerNormalizedNpub: string | null,
  viewerIsAdmin: boolean,
): boolean {
  if (viewerIsAdmin) {
    return true;
  }
  if (!viewerNormalizedNpub) {
    return false;
  }
  return resolveSessionOwnerNpub(sessionNpub, metadata) === viewerNormalizedNpub;
}

import type { SessionSnapshot } from "../agents/process-manager";
import type { SessionApiContext } from "./session-api-routes";
import { generateIdentityAlias } from "../identity/identity-alias";
import { resolveSessionOwnerNpub } from "../sessions/session-ownership";

export async function handleSessionHistory(
  id: string,
  ownedSession: SessionSnapshot | null,
  viewerNormalizedNpub: string | null,
  viewerIsAdmin: boolean,
  ctx: SessionApiContext,
): Promise<Response> {
  // Check if session is running first
  if (ownedSession) {
    const messages = ctx.messageStore.listSessionMessages(id);
    return Response.json({
      id,
      status: "live",
      session: ctx.serializeSession(ownedSession),
      messages,
    });
  }

  // Check wingman.db for abandoned session (server restart, etc.)
  const storedSession = ctx.messageStore.getSession(id);
  if (storedSession) {
    const isOwned = ctx.sessionBelongsToViewer(storedSession.npub, storedSession.metadata, viewerNormalizedNpub, viewerIsAdmin);
    if (isOwned) {
      const ownerNpub = resolveSessionOwnerNpub(storedSession.npub, storedSession.metadata);
      const messages = ctx.messageStore.listSessionMessages(id);
      return Response.json({
        id,
        status: "abandoned",
        session: {
          id: storedSession.id,
          agent: storedSession.agent,
          name: storedSession.name,
          npub: storedSession.npub,
          ownerNpub,
          identityAlias: generateIdentityAlias(ownerNpub),
          workingDirectory: storedSession.workingDirectory,
          startedAt: storedSession.startedAt,
          origin: storedSession.origin,
          metadata: storedSession.metadata,
        },
        messages,
      });
    }
  }

  // Check archive store
  const archivedSession = ctx.sessionArchiveStore.getArchivedSession(id);
  if (archivedSession) {
    const isOwned = ctx.sessionBelongsToViewer(archivedSession.npub, archivedSession.metadata, viewerNormalizedNpub, viewerIsAdmin);
    if (isOwned) {
      const ownerNpub = resolveSessionOwnerNpub(archivedSession.npub, archivedSession.metadata);
      const messages = ctx.sessionArchiveStore.getArchivedMessages(id);
      return Response.json({
        id,
        status: "archived",
        session: {
          id: archivedSession.id,
          agent: archivedSession.agent,
          name: archivedSession.name,
          npub: archivedSession.npub,
          ownerNpub,
          identityAlias: generateIdentityAlias(ownerNpub),
          workingDirectory: archivedSession.workingDirectory,
          startedAt: archivedSession.startedAt,
          archivedAt: archivedSession.archivedAt,
          origin: archivedSession.origin,
          metadata: archivedSession.metadata,
        },
        messages,
      });
    }
  }

  return Response.json({ error: "Session not found" }, { status: 404 });
}

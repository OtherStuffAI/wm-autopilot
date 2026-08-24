import type { SessionSnapshot } from "../agents/process-manager";
import type { RequestAuthContext } from "./request-context";

export const WAPP_ACTIVITY_AUTHORITY_REQUIRED = "wapp-activity-authority-required";

export function hasWappActivityAuthority(
  authContext: RequestAuthContext,
  installationId: string,
  getSession: (sessionId: string) => SessionSnapshot | null | undefined,
  getScheduledInstallationId: (triggerId: string) => string | null | undefined,
): boolean {
  if (authContext.authMethod !== "nip98" || !authContext.capabilitySessionId) return false;
  const session = getSession(authContext.capabilitySessionId);
  if (!session || session.status === "stopped" || session.status === "error") return false;
  if (session.origin?.type !== "scheduler" || !session.origin.id) return false;
  return session.metadata?.wappActivityInstallationId === installationId &&
    getScheduledInstallationId(session.origin.id) === installationId;
}

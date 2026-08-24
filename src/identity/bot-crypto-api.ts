import type { SessionSnapshot } from "../agents/process-manager";
import type { StoredSessionRecord } from "../storage/message-store";
import type { WingmanInstanceIdentity } from "./wingman-instance-identity";
import { jsonError } from "../utils/request-utils";

export interface BotCryptoApiDependencies {
  getSession: (sessionId: string) => SessionSnapshot | undefined;
  getStoredSession?: (sessionId: string) => StoredSessionRecord | null;
  getInstanceIdentity?: () => WingmanInstanceIdentity | null;
}

/**
 * Compatibility tombstone for the former session-UUID-authorized crypto API.
 * All cryptographic operations now require an opaque capability at
 * /api/mcp/capabilities/*; a session UUID identifies a session but never
 * authorizes signing or decryption.
 */
export function createBotCryptoApiHandler(_deps: BotCryptoApiDependencies) {
  return async (
    _request: Request,
    url: URL,
    _method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  ): Promise<Response | null> => {
    if (!url.pathname.startsWith("/api/mcp/bot-crypto")) return null;
    return jsonError("Bot crypto API retired; use the scoped capability broker", 410);
  };
}

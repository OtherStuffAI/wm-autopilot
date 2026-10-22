import { getPublicKey, nip19 } from "nostr-tools";
import type { RequestAuthContext } from "../auth/request-context.ts";
import type { BotKeyStore } from "../identity/bot-key-store.ts";
import type { BrokerKeyVaultBackend } from "../signing/broker-key-vault.ts";
import type { AgentChatApiContext } from "./agent-chat-routes.ts";

export interface AgentProfileKeyExportContext {
  store: Pick<BotKeyStore, "getActiveKeyForBotNpub">;
  vault: Pick<BrokerKeyVaultBackend, "has" | "withKey">;
  isBotNpub: (npub: string) => boolean;
}

export function canExportAgentProfileKey(auth: RequestAuthContext, ctx: AgentChatApiContext): boolean {
  const npub = auth.session?.npub;
  return Boolean(
    npub && auth.authMethod === "session" && auth.npub === npub
    && auth.actorNpub === npub && auth.signerNpub === npub
    && !auth.error && !auth.delegatedByBot && !auth.capabilitySessionId
    && !auth.delegatedOwnerNpub && !auth.delegateRelationshipId && !auth.delegateExecutionScope
    && !auth.delegateScopes?.length && !auth.advisoryOwnerNpub
    && ctx.isAdminContext?.(auth) === true
    && ctx.keyExport && !ctx.keyExport.isBotNpub(npub),
  );
}

function reply(body: object, status = 200): Response {
  return Response.json(body, { status, headers: {
    "Cache-Control": "no-store, private, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  } });
}

export async function handleAgentProfileKeyExport(
  request: Request, url: URL, auth: RequestAuthContext, ctx: AgentChatApiContext,
  managerNpub: string | null,
): Promise<Response | null> {
  const match = url.pathname.match(/^\/api\/agent-chat\/profiles\/([^/]+)\/export-nsec$/);
  if (!match) return null;
  if (!auth.session) return reply({ error: "Human administrator browser authentication required." }, auth.npub ? 403 : 401);
  if (!canExportAgentProfileKey(auth, ctx) || !managerNpub) return reply({ error: "Human administrator access required." }, 403);
  if (request.method !== "POST") return reply({ error: "POST required." }, 405);
  // This browser-only endpoint never accepts cross-origin or non-JSON submissions.
  if (request.headers.get("origin") !== url.origin
    || !request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return reply({ error: "Same-origin JSON confirmation required." }, 403);
  }
  let profileId: string;
  let body: { confirmation?: { profileId?: unknown; currentNpub?: unknown; acknowledged?: unknown } };
  try {
    profileId = decodeURIComponent(match[1]!);
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed;
  } catch {
    return reply({ error: "Invalid confirmation payload." }, 400);
  }
  const confirmation = body.confirmation;
  if (confirmation?.acknowledged !== true || confirmation.profileId !== profileId
    || typeof confirmation.currentNpub !== "string") {
    return reply({ error: "Explicit confirmation of the selected bot and current public key is required." }, 400);
  }
  const agent = ctx.manager.getAgentForManager(profileId, managerNpub);
  if (!agent) return reply({ error: "Agent profile not found." }, 404);
  if (agent.botNpub !== confirmation.currentNpub) return reply({ error: "Bot identity changed. Refresh and confirm again." }, 409);
  const { store, vault } = ctx.keyExport!;
  const record = store.getActiveKeyForBotNpub(agent.botNpub);
  if (!record || !vault.has(record)) return reply({ error: "No locally stored exportable key. This identity may use external or unprovisioned key custody." }, 409);
  if (record.userNpub !== agent.managedByNpub || record.userNpub !== managerNpub
    || record.botNpub !== agent.botNpub || record.isActive !== 1) {
    return reply({ error: "Stored key identity or ownership is inconsistent." }, 409);
  }
  try {
    return await vault.withKey(record, (secret) => {
      if (nip19.npubEncode(getPublicKey(secret)) !== agent.botNpub) throw new Error();
      // Recheck after asynchronous vault access; never release a retired/rebound identity.
      const current = ctx.manager.getAgentForManager(profileId, managerNpub);
      if (current?.botNpub !== agent.botNpub || store.getActiveKeyForBotNpub(agent.botNpub)?.id !== record.id) {
        return reply({ error: "Bot identity changed. Refresh and confirm again." }, 409);
      }
      return reply({ profileId, botNpub: agent.botNpub, nsec: nip19.nsecEncode(secret) });
    });
  } catch {
    // Never forward vault/library errors or secret-bearing objects to logs or clients.
    return reply({ error: "Stored key could not be exported safely. Check local key custody." }, 409);
  }
}

import { inboxAwareFetchers } from '../agent-chat/agent-inbox-scope';
import type { AgentInboxStore } from '../agent-chat/agent-inbox-store';
import {
  agentInboxState, currentInboxOrigin, type AgentInboxOriginStore, liveInboxOrigin, originCovers, type InboxLocation, type InboxOriginOwner, type LiveOrigin,
} from '../agent-chat/agent-inbox-origins';
import { mentionsAddressSelf } from '../agent-chat/mention-signature';

/**
 * Agent session tools (MCP helper, and the CLI through it) for a subscription opted into the strict inbox.
 *
 * The strict inbox is a delivery profile: the session is woken only for notifications addressed to its bot. Tools and
 * CLI are the ordinary signed ones, pinned to the session's bot identity and authorized by Tower against that bot's ACL.
 * The exact notification the session acts for (agent-inbox-origins) only adds provenance to writes inside its location.
 */

/** Writes that name the current origin when it binds their location (Tower mints a work receipt / verifies self-address). */
const INBOX_ORIGIN_WRITE_ACTIONS = new Set(['chat_reply', 'doc_create', 'task_create', 'file_upload']);
/** Creations bound to the origin's channel. */
const INBOX_CHANNEL_CREATE_ACTIONS = new Set(['doc_create', 'task_create', 'file_upload']);

const refuse = (code: string, message: string, status = 403) => Response.json({ error: message, code }, { status });

export function isInboxSession(subscriptionId: string | null | undefined): subscriptionId is string {
  return Boolean(subscriptionId && agentInboxState().isInboxRequired(subscriptionId));
}

/** Who a helper call acts for: a worker's immutable snapshot, its pipeline run's origin, or the session's own turns. */
export function inboxOriginOwner(ctx: { session: { id: string; metadata?: { role?: string } | null }; rootRunId: string | null; subscriptionId: string }): InboxOriginOwner {
  return { sessionId: ctx.session.id, runId: ctx.rootRunId, subscriptionId: ctx.subscriptionId, worker: ctx.session.metadata?.role === 'dispatched-worker' };
}

/** A live origin that binds the requested location. */
export type BoundOrigin = Extract<LiveOrigin, { ok: true }>;

/** Store overrides (tests); the shared instance stores are used otherwise. */
export interface InboxOriginStores {
  inbox?: Pick<AgentInboxStore, 'bindingRecord' | 'get'>;
  origins?: Pick<AgentInboxOriginStore, 'history'>;
}

const refuseOrigin = (code: string) => refuse(code, code === 'agent_inbox_no_origin'
  ? 'This session was not started for a strict-inbox notification; it cannot act on notified context.'
  : 'The notification this session acts for is no longer live (failed, revoked, before the subscription floor or unknown).');

/** Where each write must be: a thread, task or document of the origin, or its channel for creations. */
export function writeLocation(action: string, ids: { channelId: string | null; threadId: string | null; taskId: string | null; documentId: string | null }): InboxLocation & { channelOnly?: boolean } {
  if (action === 'task_comment' || action === 'task_state') return { taskId: ids.taskId };
  if (action === 'doc_reply' || action === 'doc_update') return { docId: ids.documentId };
  if (INBOX_CHANNEL_CREATE_ACTIONS.has(action)) return { channelId: ids.channelId, channelOnly: true };
  return { channelId: ids.channelId, threadId: ids.threadId };
}

/**
 * Write origin: ONLY the origin the session acts for right now (current turn, or the worker/run snapshot). It must be
 * live and must bind the target. There is no fallback to other notifications or sessions.
 */
export function resolveInboxWriteOrigin(owner: InboxOriginOwner, action: string, ids: { channelId: string | null; threadId: string | null; taskId: string | null; documentId: string | null },
  stores: InboxOriginStores = {}): BoundOrigin | Response {
  const live = liveInboxOrigin(currentInboxOrigin(owner, stores.origins), stores.inbox);
  if (!live.ok) return refuseOrigin(live.code);
  const where = writeLocation(action, ids);
  if (!originCovers(live.envelope, where)) {
    return refuse('agent_inbox_write_unbound', `${action} is only available in the thread, task, document or channel of the notification this session acts for.`);
  }
  return live;
}

/**
 * A deliberate self-address (structured agent mention of the bot itself) from a strict-inbox session: names the live
 * non-self origin and the mentions to sign. Anything else (no origin, no self mention) is an ordinary message.
 */
export function inboxSelfAddress(origin: BoundOrigin | undefined, mentions: unknown, botNpub: string): { originNotificationId: string; mentions: unknown[] } | null {
  if (!origin || !Array.isArray(mentions) || !mentionsAddressSelf(mentions, botNpub)) return null;
  return { originNotificationId: origin.towerOriginId, mentions };
}

/**
 * Tower's minted work receipt from a create response, surfaced unchanged to the session (Tower is the only authority;
 * Autopilot never mints, stores or advances receipts). Absent when Tower minted none.
 */
export function workReceiptOf(result: unknown): { work_receipt?: Record<string, unknown> } {
  const receipt = result && typeof result === 'object' ? (result as { work_receipt?: unknown }).work_receipt : undefined;
  return receipt && typeof receipt === 'object' && !Array.isArray(receipt) ? { work_receipt: receipt as Record<string, unknown> } : {};
}

/**
 * The live origin this write may name: only for origin-carrying writes, only the session's current origin, and only when
 * it binds the target. Otherwise the write is an ordinary bot write (Tower authorizes it by the bot's ACL).
 */
export function currentInboxWriteOrigin(owner: InboxOriginOwner, action: string,
  ids: { channelId: string | null; threadId: string | null; taskId: string | null; documentId: string | null }, stores: InboxOriginStores = {}): BoundOrigin | undefined {
  if (!INBOX_ORIGIN_WRITE_ACTIONS.has(action)) return undefined;
  const origin = resolveInboxWriteOrigin(owner, action, ids, stores);
  return origin instanceof Response ? undefined : origin;
}

export { inboxAwareFetchers };

import { AgentInboxError, fetchAgentInboxAttachment, fetchAgentInboxContext } from '../agent-chat/agent-inbox-client';
import { agentInboxScope, inboxAwareFetchers, type AgentInboxContext, type AgentInboxScope } from '../agent-chat/agent-inbox-scope';
import { agentInboxStore, type AgentInboxStore } from '../agent-chat/agent-inbox-store';
import {
  currentInboxOrigin, inboxOriginCandidates, type AgentInboxOriginStore, liveInboxOrigin, originCovers, type InboxLocation, type InboxOriginOwner, type LiveOrigin,
} from '../agent-chat/agent-inbox-origins';
import type { FlightDeckPgBotIdentity } from '../agent-chat/tower-client';
import { decodeFlightDeckPgDocumentBody, type FlightDeckPgDocumentResult } from '../agent-chat/tower-client';
import { capturedDocumentBase } from '../flightdeck-pg/document-update-base';
import { mentionsAddressSelf } from '../agent-chat/mention-signature';

/**
 * Agent session tools (MCP helper, and the CLI through it) for a subscription opted into the strict inbox.
 *
 * Every call acts for the exact notification the session was started or prompted for (agent-inbox-origins): reads are
 * answered ONLY from that notification's recipient-bound context (or an earlier turn of the same session), fetched with
 * the bot's own key. Writes go only into the location the current origin binds; Tower re-checks for classified bots.
 * Generic Tower proxies are refused.
 */
export const INBOX_READ_ACTIONS = new Set(['thread_read', 'doc_get', 'doc_comments', 'task_comments', 'task_get', 'attachment_get']);
export const INBOX_SCOPED_WRITE_ACTIONS = new Set(['doc_update', 'task_state']);
/** Writes allowed only into a location a handled notification binds (Autopilot-side; Tower re-checks when classified). */
export const INBOX_BOUND_WRITE_ACTIONS = new Set(['chat_reply', 'task_comment', 'doc_reply', 'doc_create', 'task_create', 'file_upload']);
/** Creations bound to the origin's channel. */
const INBOX_CHANNEL_CREATE_ACTIONS = new Set(['doc_create', 'task_create', 'file_upload']);
export const INBOX_REFUSED_ACTIONS = new Set(['transport_prepare', 'transport_request', 'record_sync_request', 'daily_scope_get', 'daily_scope_upsert']);

export interface InboxSessionTarget {
  subscriptionId: string;
  backendConnectionId: string | null;
  backendBaseUrl: string;
  workspaceId: string;
  appNpub: string;
  botIdentity: FlightDeckPgBotIdentity;
}

const refuse = (code: string, message: string, status = 403) => Response.json({ error: message, code }, { status });

export function isInboxSession(subscriptionId: string | null | undefined): subscriptionId is string {
  return Boolean(subscriptionId && agentInboxStore().isInboxRequired(subscriptionId));
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

/**
 * Read origin: the session's current origin, else an earlier turn of the SAME session that covers the location. Never
 * another session's notification and never a newer notification for the location.
 */
export function resolveInboxReadOrigin(owner: InboxOriginOwner, where: InboxLocation, stores: InboxOriginStores = {}): BoundOrigin | Response {
  const candidates = inboxOriginCandidates(owner, stores.origins);
  if (!candidates.length) return refuseOrigin('agent_inbox_no_origin');
  for (const candidate of candidates) {
    const live = liveInboxOrigin(candidate, stores.inbox);
    if (live.ok && originCovers(live.envelope, where)) return live;
  }
  return refuse('agent_inbox_no_bound_notification', 'No notification this session acts for binds this location; reads outside notified context are not available.');
}

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

/** Recipient-bound context of an exact live origin, fetched with the bot's own key (never a raw Tower read). */
export async function resolveInboxSessionScope(target: InboxSessionTarget, origin: BoundOrigin): Promise<AgentInboxScope | Response> {
  try {
    const context = await fetchAgentInboxContext<AgentInboxContext>({ ...target }, origin.envelope.id);
    return { notification: origin.envelope as any, context, profileNpub: target.botIdentity.botNpub, subscriptionId: target.subscriptionId };
  } catch (error) {
    if (error instanceof AgentInboxError) return refuse(error.code, error.message, error.status && error.status >= 400 ? error.status : 502);
    throw error;
  }
}

export function inboxLocation(action: string, ids: { channelId: string | null; threadId: string | null; taskId: string | null; documentId: string | null }): InboxLocation {
  if (action.startsWith('task_')) return { taskId: ids.taskId };
  if (action.startsWith('doc_')) return { docId: ids.documentId };
  return { channelId: ids.channelId, threadId: ids.threadId };
}

/** Answers a read action from the bound context (same response shapes as the raw helper actions). */
export function answerInboxRead(action: string, scope: AgentInboxScope): Response {
  const context = scope.context;
  const trigger = context.trigger;
  const bounded = { bounded: true, notification_id: scope.notification.id, policy: (context as any).policy ?? null };
  if (action === 'thread_read') {
    if (!trigger?.message) return refuse('agent_inbox_context_unbound', 'The bound notification is not a chat message.');
    const messages = [...(context.window?.messages ?? []), trigger.message];
    return Response.json({ ok: true, channel_id: trigger.message.channel_id, thread_id: trigger.message.thread_id ?? null, effective_transcript: Boolean(trigger.message.thread_id),
      messages, next_cursor: null, complete: !context.window?.truncated, page_size: messages.length, pages_read: 1, ...bounded });
  }
  if (action === 'doc_get') {
    const document = trigger?.document;
    if (!document) return refuse('agent_inbox_context_unbound', 'The bound notification has no document.');
    const result: FlightDeckPgDocumentResult = {
      doc: { id: document.id, title: document.title, row_version: document.row_version, channel_id: document.channel_id } as any,
      ...(document.canonical_version ? { canonical_version: document.canonical_version as any } : {}),
      ...(document.body ? { body: document.body as any } : {}),
    };
    return Response.json({ ok: true, ...result, body_text: decodeFlightDeckPgDocumentBody(result), captured_base: result.canonical_version ? capturedDocumentBase(result) : null, ...bounded });
  }
  if (action === 'doc_comments') {
    if (!trigger?.document) return refuse('agent_inbox_context_unbound', 'The bound notification has no document.');
    const comments = trigger.comment ? [{ id: trigger.comment.id, doc_id: trigger.document.id, parent_comment_id: trigger.comment.parent_comment_id ?? null,
      body: trigger.comment.body, metadata: { mentions: trigger.comment.mentions ?? [] }, created_at: trigger.comment.created_at, sender_npub: trigger.comment.author_npub }] : [];
    return Response.json({ ok: true, doc_id: trigger.document.id, comments, next_cursor: null, ...bounded });
  }
  if (action === 'task_comments' || action === 'task_get') {
    if (!trigger?.task) return refuse('agent_inbox_context_unbound', 'The bound notification has no task.');
    if (action === 'task_get') return Response.json({ ok: true, task: trigger.task, ...bounded });
    const comments = [...(context.window?.comments ?? []), ...(trigger.comment ? [trigger.comment] : [])]
      .map((c: any) => ({ id: c.id, task_id: trigger.task!.id, body: c.body, metadata: { mentions: c.mentions ?? [] }, created_at: c.created_at, sender_npub: c.author_npub }));
    return Response.json({ ok: true, task_id: trigger.task.id, comments, next_cursor: null, ...bounded });
  }
  return refuse('agent_inbox_unbound_action', `${action} is not available to a strict-inbox agent session.`);
}

/**
 * Download-only attachment of the bound notification's trigger/transcript (Tower re-checks binding and access on every
 * request; no bearer URL). Returned base64 is capped so a session tool cannot pull arbitrary large blobs.
 */
export async function answerInboxAttachment(target: InboxSessionTarget, scope: AgentInboxScope, storageObjectId: string | null, maxBytes = 25 * 1024 * 1024): Promise<Response> {
  if (!storageObjectId) return refuse('validation_error', 'storageObjectId is required', 400);
  const known = [scope.context.trigger?.message, ...(scope.context.window?.messages ?? [])]
    .flatMap((m: any) => (Array.isArray(m?.attachments) ? m.attachments : []))
    .find((a: any) => a?.storage_object_id === storageObjectId);
  if (!known) return refuse('agent_inbox_context_unbound', 'The attachment is not part of the bound notification context.');
  try {
    const response = await fetchAgentInboxAttachment({ ...target }, scope.notification.id, storageObjectId);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) return refuse('attachment_too_large', 'Attachment exceeds the session download limit.', 413);
    return Response.json({ ok: true, storage_object_id: storageObjectId, file_name: known.file_name ?? null, content_type: response.headers.get('content-type'),
      size_bytes: bytes.byteLength, base64_data: Buffer.from(bytes).toString('base64'), bounded: true, notification_id: scope.notification.id });
  } catch (error) {
    if (error instanceof AgentInboxError) return refuse(error.code, error.message, error.status && error.status >= 400 ? error.status : 502);
    throw error;
  }
}

export function runInScope<T>(scope: AgentInboxScope, work: () => Promise<T>): Promise<T> {
  return agentInboxScope.run(scope, work);
}

export { inboxAwareFetchers };

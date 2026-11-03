import { AgentInboxError, fetchAgentInboxAttachment, fetchAgentInboxContext } from '../agent-chat/agent-inbox-client';
import { agentInboxScope, inboxAwareFetchers, type AgentInboxContext, type AgentInboxScope } from '../agent-chat/agent-inbox-scope';
import { agentInboxStore } from '../agent-chat/agent-inbox-store';
import type { FlightDeckPgBotIdentity } from '../agent-chat/tower-client';
import { decodeFlightDeckPgDocumentBody, type FlightDeckPgDocumentResult } from '../agent-chat/tower-client';
import { capturedDocumentBase } from '../flightdeck-pg/document-update-base';

/**
 * Agent session tools (MCP helper, and the CLI through it) for a subscription opted into the strict inbox.
 *
 * Reads are answered ONLY from the recipient-bound context of the newest notification this subscription handled for
 * the requested thread/task/document, fetched with the bot's own key. Generic Tower proxies are refused. Writes go to
 * Tower unchanged (Tower enforces notification binding for classified bots); their pre-reads run inside the scope.
 */
export const INBOX_READ_ACTIONS = new Set(['thread_read', 'doc_get', 'doc_comments', 'task_comments', 'task_get', 'attachment_get']);
export const INBOX_SCOPED_WRITE_ACTIONS = new Set(['doc_update', 'task_state']);
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

/** Resolves the scope for a location, or a refusal. Never falls back to a raw Tower read. */
export async function resolveInboxSessionScope(target: InboxSessionTarget, where: { channelId?: string | null; threadId?: string | null; taskId?: string | null; docId?: string | null }): Promise<AgentInboxScope | Response> {
  const envelope = agentInboxStore().latestBound(target.subscriptionId, where);
  if (!envelope) return refuse('agent_inbox_no_bound_notification', 'No strict-inbox notification binds this location for this agent; reads outside notified context are not available.');
  try {
    const context = await fetchAgentInboxContext<AgentInboxContext>({ ...target }, envelope.id);
    return { notification: envelope as any, context, profileNpub: target.botIdentity.botNpub };
  } catch (error) {
    if (error instanceof AgentInboxError) return refuse(error.code, error.message, error.status && error.status >= 400 ? error.status : 502);
    throw error;
  }
}

export function inboxLocation(action: string, ids: { channelId: string | null; threadId: string | null; taskId: string | null; documentId: string | null }) {
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

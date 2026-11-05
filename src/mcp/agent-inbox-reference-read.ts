import { AgentInboxError, fetchAgentInboxReference, type AgentInboxReference } from '../agent-chat/agent-inbox-client';
import { inboxOriginCandidates, liveInboxOrigin, type InboxOriginOwner } from '../agent-chat/agent-inbox-origins';
import { documentReadResponse, type InboxSessionTarget } from './agent-inbox-session-helper';

/**
 * Reads of records the session's notified text references (a human's `mention:chat|doc|task` token). Autopilot never
 * decides what is referenced or readable: it asks Tower, signed with the bot's own key, once per live notification the
 * session acts for (newest first). Tower answers only for a live notification whose text a human used to reference
 * exactly that record and whose author can read it; any other answer leaves the original refusal in place.
 */
export const INBOX_REFERENCE_READ_ACTIONS = new Set(['thread_read', 'doc_get', 'task_get', 'task_comments']);
const MAX_CANDIDATES = 5;
/** Tower answers for "not referenced / not readable / notification not usable" with these; the next candidate may still serve. */
const NEXT_CANDIDATE_STATUS = new Set([403, 404, 410]);

export interface InboxReferenceIds { channelId: string | null; threadId: string | null; taskId: string | null; documentId: string | null }
export interface InboxReferenceDeps { fetchReference?: typeof fetchAgentInboxReference }

export function referenceFor(action: string, ids: InboxReferenceIds): AgentInboxReference | null {
  if (action === 'thread_read') return ids.channelId && ids.threadId ? { type: 'thread', channelId: ids.channelId, threadId: ids.threadId } : null;
  if (action === 'doc_get') return ids.documentId ? { type: 'doc', id: ids.documentId } : null;
  if (action === 'task_get' || action === 'task_comments') return ids.taskId ? { type: 'task', id: ids.taskId } : null;
  return null;
}

/** A response in the raw helper's shape, or null when no live notification of this session can serve the reference. */
export async function answerInboxReference(call: { action: string; owner: InboxOriginOwner; ids: InboxReferenceIds; target: InboxSessionTarget },
  deps: InboxReferenceDeps = {}): Promise<Response | null> {
  const reference = INBOX_REFERENCE_READ_ACTIONS.has(call.action) ? referenceFor(call.action, call.ids) : null;
  if (!reference) return null;
  const tried = new Set<string>();
  for (const candidate of inboxOriginCandidates(call.owner)) {
    const live = liveInboxOrigin(candidate);
    if (!live.ok || tried.has(live.towerOriginId)) continue;
    tried.add(live.towerOriginId);
    if (tried.size > MAX_CANDIDATES) break;
    try {
      const result = await (deps.fetchReference ?? fetchAgentInboxReference)({ ...call.target }, live.towerOriginId, reference);
      return shape(call.action, reference, live.towerOriginId, result);
    } catch (error) {
      if (error instanceof AgentInboxError && NEXT_CANDIDATE_STATUS.has(error.status)) continue;
      throw error;
    }
  }
  return null;
}

function shape(action: string, reference: AgentInboxReference, notificationId: string, result: Record<string, any>): Response {
  const referenced = { bounded: true, referenced: true, notification_id: notificationId };
  if (action === 'thread_read' && reference.type === 'thread') {
    const messages = Array.isArray(result.messages) ? result.messages : [];
    return Response.json({ ok: true, channel_id: reference.channelId, thread_id: reference.threadId, effective_transcript: true, messages, next_cursor: null,
      complete: !result.truncated, page_size: messages.length, pages_read: 1, ...referenced });
  }
  if (action === 'doc_get' && result.document) return documentReadResponse(result.document, { ...referenced, captured_base: null });
  if (action === 'task_get' && result.task) return Response.json({ ok: true, task: result.task, ...referenced });
  if (action === 'task_comments' && result.task) {
    const comments = (Array.isArray(result.comments) ? result.comments : [])
      .map((c: any) => ({ id: c.id, task_id: result.task.id, body: c.body, metadata: { mentions: c.mentions ?? [] }, created_at: c.created_at, sender_npub: c.author_npub }));
    return Response.json({ ok: true, task_id: result.task.id, comments, next_cursor: null, ...referenced });
  }
  return Response.json({ error: 'The referenced record could not be read in this form.', code: 'agent_inbox_reference_malformed' }, { status: 502 });
}

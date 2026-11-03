import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentInboxEnvelope } from './agent-inbox-client';
import type {
  FlightDeckPgChannel, FlightDeckPgDocumentComment, FlightDeckPgDocumentResult, FlightDeckPgEvent, FlightDeckPgMessage,
  FlightDeckPgTaskComment,
} from './tower-client';

/**
 * Strict-inbox handling scope. While a notification is being dispatched, Flight Deck reads made by the existing
 * chat/task/document handlers are answered ONLY from that notification's recipient-bound Tower context. Reads outside
 * the bound entities return empty/minimal results (secondary context) or fail (primary entity mismatch). No raw Tower
 * read is made inside the scope, so no broad visibility is ever consulted on behalf of an inbox profile.
 */
export interface AgentInboxScope {
  notification: AgentInboxEnvelope;
  context: AgentInboxContext;
  profileNpub: string;
}

export interface AgentInboxContext {
  notification?: AgentInboxEnvelope;
  channel?: { id: string; workspace_id?: string; scope_id?: string | null; name?: string | null; kind?: string | null; metadata?: Record<string, unknown>; agent_chat?: unknown };
  thread?: { id: string; title?: string; source_message_id?: string | null; parent_thread_id?: string | null } | null;
  trigger?: {
    type: string;
    message?: FlightDeckPgMessage & Record<string, unknown>;
    task?: Record<string, any> | null;
    comment?: Record<string, any> | null;
    document?: { id: string; title?: string; row_version?: number; channel_id?: string; body?: Record<string, unknown> | null; body_too_large?: boolean; canonical_version?: Record<string, unknown> | null } | null;
    invocation?: { id: string; prompt: string; targets: Array<{ type?: string; id?: string }>; status?: string; trigger?: string | null; author_npub?: string | null; created_at?: string };
  };
  window?: { messages?: Array<FlightDeckPgMessage & Record<string, unknown>>; comments?: Array<Record<string, any>>; truncated?: boolean };
}

export const agentInboxScope = new AsyncLocalStorage<AgentInboxScope>();

export class AgentInboxUnboundReadError extends Error {
  status = 403;
  detailCode = 'agent_inbox_context_unbound';
  constructor(what: string) {
    super(`Read outside the notification's authorized context was refused (${what}).`);
  }
}

/**
 * The notification's bounded effective transcript for its own thread, shaped like an effective thread read. Refuses
 * (never falls back to a raw read) when the requested thread is not the one the notification binds.
 */
export function boundThreadHistory(scope: AgentInboxScope, where: { workspaceId: string; channelId: string; threadId: string }): FlightDeckPgMessage[] {
  const trigger = scope.context.trigger?.message;
  if (!trigger || trigger.channel_id !== where.channelId || (trigger.thread_id ?? trigger.id) !== where.threadId) {
    throw new AgentInboxUnboundReadError(`thread ${where.threadId}`);
  }
  return boundMessages(scope).map((message) => ({
    ...message,
    workspace_id: message.workspace_id ?? where.workspaceId,
    effective_thread_id: where.threadId,
  }));
}

type AnyFn = (params: any) => Promise<any>;

function contextChannel(scope: AgentInboxScope): FlightDeckPgChannel | null {
  const channel = scope.context.channel;
  if (!channel?.id) return null;
  return {
    id: channel.id, workspace_id: channel.workspace_id, scope_id: channel.scope_id ?? null, name: channel.name ?? null,
    kind: channel.kind ?? null, metadata: channel.metadata ?? (channel.agent_chat ? { agent_chat: channel.agent_chat } : {}),
  };
}

function boundMessages(scope: AgentInboxScope): FlightDeckPgMessage[] {
  const window = scope.context.window?.messages ?? [];
  const trigger = scope.context.trigger?.message;
  return [...window, ...(trigger ? [trigger] : [])];
}

/** Wraps the Tower read functions the dispatch handlers use. Outside an inbox scope they delegate unchanged. */
export function inboxAwareFetchers<T extends Record<string, AnyFn>>(real: T): T {
  const wrap = (name: string, inScope: (scope: AgentInboxScope, params: any) => Promise<unknown> | unknown): AnyFn => async (params: any) => {
    const scope = agentInboxScope.getStore();
    if (!scope) return real[name]!(params);
    return inScope(scope, params);
  };
  const out: Record<string, AnyFn> = { ...real };
  if (real.fetchChannel) {
    out.fetchChannel = wrap('fetchChannel', (scope, params) => {
      const channel = contextChannel(scope);
      // Secondary channel context outside the binding degrades to a bare reference (no name/description/metadata).
      return channel && channel.id === params.channelId ? channel : { id: params.channelId, workspace_id: params.workspaceId, scope_id: null };
    });
  }
  if (real.fetchMessages) {
    out.fetchMessages = wrap('fetchMessages', (scope, params) => {
      const trigger = scope.context.trigger?.message;
      const boundThread = trigger?.thread_id ?? null;
      const sameThread = trigger && params.channelId === trigger.channel_id && (params.threadId ?? null) === boundThread;
      return { messages: sameThread ? boundMessages(scope) : [], next_cursor: null, effective_transcript: Boolean(params.effectiveTranscript) };
    });
  }
  if (real.fetchTask) {
    out.fetchTask = wrap('fetchTask', (scope, params) => {
      const task = scope.context.trigger?.task;
      if (!task || task.id !== params.taskId) throw new AgentInboxUnboundReadError('task');
      return { task: { ...task, thread_id: null } };
    });
  }
  if (real.fetchComments) {
    out.fetchComments = wrap('fetchComments', (scope, params) => {
      const trigger = scope.context.trigger;
      if (!trigger) throw new AgentInboxUnboundReadError('comments');
      if (params.taskId) {
        if (trigger?.task?.id !== params.taskId) throw new AgentInboxUnboundReadError('task comments');
        const comments: FlightDeckPgTaskComment[] = [...(scope.context.window?.comments ?? []), ...(trigger.comment ? [trigger.comment] : [])]
          .map((c: any) => ({ id: c.id, task_id: params.taskId, body: c.body, metadata: { mentions: c.mentions ?? [] }, created_at: c.created_at, created_by_actor_npub: c.author_npub }) as FlightDeckPgTaskComment);
        return { comments, next_cursor: null };
      }
      if (params.documentId) {
        if (trigger?.document?.id !== params.documentId) throw new AgentInboxUnboundReadError('document comments');
        const comments: FlightDeckPgDocumentComment[] = trigger.comment
          ? [{ id: trigger.comment.id, doc_id: params.documentId, parent_comment_id: trigger.comment.parent_comment_id ?? null, body: trigger.comment.body,
            metadata: { mentions: trigger.comment.mentions ?? [] }, created_at: trigger.comment.created_at, created_by_actor_npub: trigger.comment.author_npub,
            sender_npub: trigger.comment.author_npub }]
          : [];
        return { comments, next_cursor: null };
      }
      throw new AgentInboxUnboundReadError('comments');
    });
  }
  if (real.fetchDocument) {
    out.fetchDocument = wrap('fetchDocument', (scope, params) => {
      const document = scope.context.trigger?.document;
      if (!document || document.id !== params.documentId) throw new AgentInboxUnboundReadError('document');
      const result: FlightDeckPgDocumentResult = {
        doc: { id: document.id, title: document.title, row_version: document.row_version, channel_id: document.channel_id } as any,
        ...(document.canonical_version ? { canonical_version: document.canonical_version as any } : {}),
        ...(params.includeBody && document.body ? { body: document.body as any } : {}),
      };
      return result;
    });
  }
  if (real.fetchWorkroomContext) {
    out.fetchWorkroomContext = wrap('fetchWorkroomContext', () => { throw new AgentInboxUnboundReadError('workroom context'); });
  }
  return out as T;
}

/**
 * Builds the legacy-shaped event(s) the existing handlers consume from a strict notification + its context. Addressing
 * is exactly the notification (this profile only); no other recipient is ever named.
 */
export function synthesizeInboxEvents(n: AgentInboxEnvelope, context: AgentInboxContext, profileNpub: string): FlightDeckPgEvent[] {
  const source = n.source!;
  const self = [{ type: 'agent', npub: profileNpub }];
  const base = {
    id: n.id, event_id: n.id, cursor: null, workspace_id: context.channel?.workspace_id, scope_id: context.channel?.scope_id ?? null,
    channel_id: source.channel_id, entity_row_version: source.version ?? null, created_at: n.occurred_at,
    visible_to_audience_npubs: [profileNpub], visible_to_agent_npubs: [profileNpub],
  };
  switch (n.kind) {
    case 'chat_mention':
    case 'direct_message':
    case 'agent_direct_recipient':
      return [{
        ...base, event_type: 'flightdeck_pg.message.created', entity_type: 'message', entity_id: source.id, operation: 'created',
        thread_id: source.thread_id, payload: { thread_id: source.thread_id, channel_id: source.channel_id, mentions: context.trigger?.message?.mentions ?? [] },
      }];
    case 'task_assigned':
      return [{
        ...base, event_type: 'flightdeck_pg.task_assignment.assigned', entity_type: 'task_assignment', entity_id: source.task_id, operation: 'assigned',
        payload: { task_id: source.task_id, assignee: { npub: profileNpub }, transition: { previous: 'absent', current: 'present' } },
      }];
    case 'task_mention':
      return [{ ...base, event_type: 'flightdeck_pg.task.created', entity_type: 'task', entity_id: source.task_id, operation: 'created', payload: { task_id: source.task_id, mentions: self } }];
    case 'task_comment_mention':
      return [{
        ...base, event_type: 'flightdeck_pg.task_comment.created', entity_type: 'task_comment', entity_id: source.id, operation: 'created',
        payload: { task_id: source.task_id, comment_id: source.id, mentions: self },
      }];
    case 'document_mention':
      return [{
        ...base, event_type: 'flightdeck_pg.document_mention_added', entity_type: 'doc', entity_id: source.doc_id, operation: 'updated',
        payload: { document_id: source.doc_id, doc_id: source.doc_id, added_mentions: self },
      }];
    case 'document_comment_mention':
      return [{
        ...base, event_type: 'flightdeck_pg.document_comment_mention_added', entity_type: 'doc_comment', entity_id: source.id, operation: 'created',
        payload: { document_id: source.doc_id, doc_id: source.doc_id, comment_id: source.id, added_mentions: self },
      }];
    case 'invocation':
    case 'document_review': {
      const invocation = context.trigger?.invocation;
      const invocationEvent: FlightDeckPgEvent = {
        ...base, event_type: 'flightdeck_pg.invocation.created', entity_type: 'invocation', entity_id: source.id, operation: 'created',
        payload: {
          invocation_id: source.id, scope_id: context.channel?.scope_id ?? null, channel_id: source.channel_id, prompt: invocation?.prompt ?? '',
          recipients: self, targets: invocation?.targets ?? [], created_by_npub: invocation?.author_npub ?? null,
          metadata: invocation?.trigger ? { trigger: invocation.trigger } : {},
        },
      };
      if (n.kind !== 'document_review') return [invocationEvent];
      // Legacy parity: a full review request reached both the invocation pipeline and the document runtime.
      return [invocationEvent, {
        ...base, id: `${n.id}:review`, event_id: `${n.id}:review`, event_type: 'flightdeck_pg.full_document_review_requested', entity_type: 'doc',
        entity_id: source.doc_id, operation: 'updated',
        payload: { trigger: 'full_document_review_requested', invocation_id: source.id, document_id: source.doc_id, doc_id: source.doc_id, agent: { npub: profileNpub }, prompt: invocation?.prompt ?? '' },
      }];
    }
    default:
      return [];
  }
}

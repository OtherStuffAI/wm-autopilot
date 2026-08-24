import { createHash } from 'node:crypto';

import type { FlightDeckPgEvent } from './tower-client';

export type DocumentDirectTriggerReason =
  | 'document_mention_added'
  | 'document_comment_mention_added'
  | 'full_document_review_requested';

export interface DocumentDirectTrigger {
  documentId: string;
  eventId: string;
  eventSignature: string;
  reason: DocumentDirectTriggerReason;
  targetAgentNpubs: string[];
  sourceCommentId: string | null;
  source: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function mentionNpubs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((item) => {
    const mention = record(item);
    if (text(mention.type) && text(mention.type) !== 'agent') return [];
    const npub = text(mention.npub) ?? text(mention.agent_npub) ?? text(mention.actor_npub);
    return npub ? [npub] : [];
  }))];
}

export function buildDocumentDirectRoutingKey(input: {
  towerServiceNpub: string;
  workspaceId: string;
  agentId: string;
  documentId: string;
}): string {
  return `document-direct:v1:${input.towerServiceNpub}:${input.workspaceId}:${input.agentId}:${input.documentId}`;
}

export function normaliseDocumentDirectTrigger(event: FlightDeckPgEvent): DocumentDirectTrigger | null {
  if (event.operation === 'deleted') return null;
  const payload = record(event.payload);
  const comment = record(payload.comment);
  const invocation = record(payload.invocation);
  const eventId = text(event.event_id) ?? text(event.id);
  const documentId = text(payload.document_id)
    ?? text(payload.doc_id)
    ?? text(comment.doc_id)
    ?? text(payload.target_id)
    ?? text(invocation.target_id)
    ?? (event.entity_type === 'document' ? text(event.entity_id) : null);
  if (!eventId || !documentId) return null;

  let reason: DocumentDirectTriggerReason | null = null;
  let targets: string[] = [];
  if (event.event_type === 'document_mention_added' || event.event_type === 'flightdeck_pg.document_mention_added') {
    reason = 'document_mention_added';
    targets = mentionNpubs(payload.added_mentions ?? payload.newly_added_mentions ?? payload.mentions);
  } else if (event.event_type === 'document_comment_mention_added' || event.event_type === 'flightdeck_pg.document_comment_mention_added') {
    reason = 'document_comment_mention_added';
    targets = mentionNpubs(payload.added_mentions ?? payload.mentions ?? comment.mentions ?? record(comment.metadata).mentions);
  } else if (event.event_type === 'full_document_review_requested' || event.event_type === 'flightdeck_pg.full_document_review_requested') {
    reason = 'full_document_review_requested';
    targets = mentionNpubs(payload.recipients ?? payload.agents ?? invocation.recipients ?? (payload.agent ? [payload.agent] : []));
    const defaultAgentNpub = text(payload.agent_npub) ?? text(payload.target_agent_npub) ?? text(invocation.agent_npub);
    if (defaultAgentNpub) targets = [...new Set([...targets, defaultAgentNpub])];
  }
  if (!reason || targets.length === 0) return null;

  const source = Object.keys(payload).length ? payload : record(event);
  const signature = JSON.stringify({ eventId, documentId, reason, source, version: event.entity_row_version ?? event.row_version ?? null });
  return {
    documentId,
    eventId,
    eventSignature: createHash('sha256').update(signature).digest('hex'),
    reason,
    targetAgentNpubs: targets,
    sourceCommentId: text(payload.comment_id) ?? text(comment.id),
    source,
  };
}

export function isDocumentDirectEvent(event: FlightDeckPgEvent): boolean {
  return new Set([
    'document_mention_added',
    'flightdeck_pg.document_mention_added',
    'document_comment_mention_added',
    'flightdeck_pg.document_comment_mention_added',
    'full_document_review_requested',
    'flightdeck_pg.full_document_review_requested',
  ]).has(String(event.event_type ?? ''));
}

export function buildDocumentDirectTurnId(routingKey: string, signatures: string[]): string {
  return createHash('sha256').update(`${routingKey}\n${signatures.join('\n')}`).digest('hex');
}

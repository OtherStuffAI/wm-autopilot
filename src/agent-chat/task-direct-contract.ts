import { createHash } from 'node:crypto';

import type { FlightDeckPgEvent } from './tower-client';

export type TaskDirectTriggerReason =
  | 'description_mention_added'
  | 'agent_assigned'
  | 'comment_mention_added';

export interface TaskDirectTrigger {
  taskId: string;
  eventId: string;
  eventSignature: string;
  reasonsByAgentNpub: Map<string, TaskDirectTriggerReason[]>;
  latestChange: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function mentionedNpubs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const mention = record(item);
    if (text(mention.type) && text(mention.type) !== 'agent') return [];
    const npub = text(mention.npub) ?? text(mention.agent_npub);
    return npub ? [npub] : [];
  });
}

function mentionIdentity(value: unknown): string | null {
  const mention = record(value);
  return text(mention.actor_id) ?? text(mention.npub) ?? text(mention.agent_npub);
}

function newlyMentionedNpubs(value: unknown): string[] {
  const transition = record(value);
  const previous = Array.isArray(transition.previous) ? transition.previous : [];
  const current = Array.isArray(transition.current) ? transition.current : [];
  const previousIdentities = new Set(previous.map(mentionIdentity).filter((identity): identity is string => Boolean(identity)));
  return current.flatMap((mention) => {
    const identity = mentionIdentity(mention);
    return identity && !previousIdentities.has(identity) ? mentionedNpubs([mention]) : [];
  });
}

function assignedNpubs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === 'string' && item.trim()) return [item.trim()];
    const assignment = record(item);
    const npub = text(assignment.npub)
      ?? text(assignment.agent_npub)
      ?? text(assignment.actor_npub);
    return npub ? [npub] : [];
  });
}

function addReasons(
  target: Map<string, Set<TaskDirectTriggerReason>>,
  npubs: string[],
  reason: TaskDirectTriggerReason,
): void {
  for (const npub of npubs) {
    const reasons = target.get(npub) ?? new Set<TaskDirectTriggerReason>();
    reasons.add(reason);
    target.set(npub, reasons);
  }
}

export function buildTaskDirectRoutingKey(input: {
  towerServiceNpub: string;
  workspaceId: string;
  agentId: string;
  taskId: string;
}): string {
  return `task-direct:v1:${input.towerServiceNpub}:${input.workspaceId}:${input.agentId}:${input.taskId}`;
}

export function normaliseTaskDirectTrigger(event: FlightDeckPgEvent): TaskDirectTrigger | null {
  const payload = record(event.payload);
  const change = Object.keys(record(payload.change)).length
    ? record(payload.change)
    : record(payload.changes);
  const comment = record(payload.comment);
  const commentMetadata = record(comment.metadata);
  const refetch = record(event.refetch);
  const taskId = text(payload.task_id)
    ?? text(change.task_id)
    ?? text(comment.task_id)
    ?? text(comment.target_record_id)
    ?? text(refetch.task_id)
    ?? (event.entity_type === 'task' ? text(event.entity_id) : null);
  const eventId = text(event.event_id) ?? text(event.id);
  if (!taskId || !eventId || event.operation === 'deleted') return null;

  const reasons = new Map<string, Set<TaskDirectTriggerReason>>();
  if (event.entity_type === 'task_comment') {
    addReasons(
      reasons,
      mentionedNpubs(payload.mentions ?? change.mentions ?? comment.mentions ?? commentMetadata.mentions),
      'comment_mention_added',
    );
  } else if (event.entity_type === 'task') {
    const hasCanonicalMentions = payload.mentions !== undefined;
    const canonicalMentions = hasCanonicalMentions
      ? event.operation === 'created'
        ? mentionedNpubs(payload.mentions)
        : event.operation === 'updated'
          ? newlyMentionedNpubs(payload.mentions)
          : []
      : [];
    addReasons(
      reasons,
      hasCanonicalMentions
        ? canonicalMentions
        : mentionedNpubs(payload.newly_added_mentions ?? change.newly_added_mentions),
      'description_mention_added',
    );
  } else if (event.entity_type === 'task_assignment') {
    const transition = record(payload.transition);
    const isAssignment = event.operation === 'assigned'
      || (text(transition.previous) === 'absent' && text(transition.current) === 'present');
    if (isAssignment) {
      addReasons(reasons, assignedNpubs([payload.assignee]), 'agent_assigned');
    }
  } else {
    return null;
  }

  // Compatibility for pre-contract synthetic task events. Tower's canonical
  // assignment events use entity_type=task_assignment and the branch above.
  if (event.entity_type === 'task') {
    addReasons(
      reasons,
      assignedNpubs(payload.newly_assigned_agents ?? change.newly_assigned_agents),
      'agent_assigned',
    );
  }
  if (reasons.size === 0) return null;

  const version = event.entity_row_version ?? event.row_version ?? payload.row_version ?? '';
  const signatureSource = JSON.stringify({ eventId, taskId, version, change: Object.keys(change).length ? change : payload });
  return {
    taskId,
    eventId,
    eventSignature: createHash('sha256').update(signatureSource).digest('hex'),
    reasonsByAgentNpub: new Map([...reasons].map(([npub, values]) => [npub, [...values]])),
    latestChange: Object.keys(change).length ? change : payload,
  };
}

export function isTaskDirectEvent(event: FlightDeckPgEvent): boolean {
  return event.operation !== 'deleted'
    && (event.entity_type === 'task'
      || event.entity_type === 'task_comment'
      || event.entity_type === 'task_assignment');
}

export function buildTaskDirectTurnId(routingKey: string, signatures: string[]): string {
  return createHash('sha256').update(`${routingKey}\n${signatures.join('\n')}`).digest('hex');
}

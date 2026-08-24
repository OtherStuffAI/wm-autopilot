import type { AgentDefinitionRecord, InboundCommentRecord, WorkspaceSubscriptionRecord } from './types';

function compactText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function compactRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function compactAttachments(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normaliseAnchorLineNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function candidatePayloads(payload: Record<string, unknown>): Record<string, unknown>[] {
  const candidates: Record<string, unknown>[] = [];
  const directData = compactRecord(payload.data);
  if (directData) {
    candidates.push({ ...payload, ...directData });
    candidates.push(directData);
  }
  candidates.push(payload);
  for (const key of ['comment', 'payload', 'record', 'content']) {
    const nested = compactRecord(payload[key]);
    if (!nested) {
      continue;
    }
    const nestedData = compactRecord(nested.data);
    if (nestedData) {
      candidates.push({ ...nested, ...nestedData });
      candidates.push(nestedData);
    }
    candidates.push(nested);
  }
  return candidates;
}

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => compactText(entry))
    .filter((entry): entry is string => Boolean(entry));
}

export function normaliseInboundCommentRecord(
  payload: Record<string, unknown>,
  record: Record<string, unknown> = {},
): InboundCommentRecord | null {
  for (const candidate of candidatePayloads(payload)) {
    const commentId = compactText(candidate.comment_id)
      ?? compactText(candidate.record_id)
      ?? compactText(candidate.id)
      ?? compactText(record.record_id);
    if (!commentId) {
      continue;
    }
    return {
      commentId,
      targetRecordId: compactText(candidate.target_record_id) ?? compactText(candidate.targetRecordId),
      targetRecordFamilyHash: compactText(candidate.target_record_family_hash) ?? compactText(candidate.targetRecordFamilyHash),
      parentCommentId: compactText(candidate.parent_comment_id) ?? compactText(candidate.parentCommentId),
      anchorLineNumber: normaliseAnchorLineNumber(
        candidate.anchor_line_number ?? candidate.anchorLineNumber,
      ),
      commentStatus: compactText(candidate.comment_status) === 'resolved' ? 'resolved' : 'open',
      body: compactText(candidate.body) ?? '',
      attachments: compactAttachments(candidate.attachments),
      senderNpub: compactText(candidate.sender_npub)
        ?? compactText(candidate.senderNpub)
        ?? compactText(record.signature_npub)
        ?? compactText(record.owner_npub),
      recordState: compactText(candidate.record_state)
        ?? compactText(candidate.recordState)
        ?? compactText(record.record_state),
    };
  }
  return null;
}

export function isTaskCommentTarget(comment: InboundCommentRecord): boolean {
  return typeof comment.targetRecordFamilyHash === 'string'
    && comment.targetRecordFamilyHash.endsWith(':task');
}

export function isDocumentCommentTarget(comment: InboundCommentRecord): boolean {
  return typeof comment.targetRecordFamilyHash === 'string'
    && comment.targetRecordFamilyHash.endsWith(':document');
}

export function getCommentThreadId(comment: InboundCommentRecord): string {
  return comment.parentCommentId ?? comment.commentId;
}

export function extractCommentGroupNpubs(record: Record<string, unknown>): string[] {
  const set = new Set<string>();
  const directGroups = getStringArray(record.group_npubs);
  for (const group of directGroups) {
    set.add(group);
  }
  const directGroup = compactText(record.group_npub);
  if (directGroup) {
    set.add(directGroup);
  }
  const groupPayloads = Array.isArray(record.group_payloads) ? record.group_payloads : [];
  for (const payload of groupPayloads) {
    const candidate = compactRecord(payload);
    if (!candidate) {
      continue;
    }
    const groupNpub = compactText(candidate.group_npub) ?? compactText(candidate.current_group_npub);
    if (groupNpub) {
      set.add(groupNpub);
    }
  }
  return [...set].sort();
}

function intersects(left: string[], right: string[]): boolean {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

export function selectDocumentCommentAgents(params: {
  subscription: WorkspaceSubscriptionRecord;
  commentRecord: Record<string, unknown>;
  agents: AgentDefinitionRecord[];
}): AgentDefinitionRecord[] {
  const commentGroups = extractCommentGroupNpubs(params.commentRecord);
  return params.agents
    .filter((agent) =>
      agent.workspaceOwnerNpub === params.subscription.workspaceOwnerNpub
      && agent.botNpub === params.subscription.botNpub
      && agent.enabled
      && agent.capabilities.includes('comment_dispatch')
      && intersects(agent.groupNpubs, commentGroups),
    )
    .sort((left, right) => left.agentId.localeCompare(right.agentId));
}

const MENTION_TOKEN_RE = /@\[([^\]]+)\]\(mention:(\w+):([^)]+)\)/g;

function normaliseMentionValue(value: string): string {
  return value.trim().toLowerCase();
}

function plainMentionMatches(body: string, value: string): boolean {
  const token = normaliseMentionValue(value);
  if (!token || token.includes(' ')) {
    return false;
  }
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w-])@${escaped}(?![\\w-])`, 'i').test(body);
}

export function commentMentionsAgent(comment: InboundCommentRecord, agent: AgentDefinitionRecord): boolean {
  const body = comment.body ?? '';
  const structuredMentionIds = new Set<string>();
  const structuredMentionLabels = new Set<string>();
  let match;
  const re = new RegExp(MENTION_TOKEN_RE.source, 'g');
  while ((match = re.exec(body)) !== null) {
    const label = normaliseMentionValue(match[1] ?? '');
    const type = normaliseMentionValue(match[2] ?? '');
    const id = normaliseMentionValue(match[3] ?? '');
    if (!id) {
      continue;
    }
    if (type === 'person') {
      structuredMentionIds.add(id);
      continue;
    }
    if (type === 'agent' || type === 'wingman' || type === 'bot') {
      structuredMentionIds.add(id);
      if (label) {
        structuredMentionLabels.add(label);
      }
    }
  }

  const agentId = normaliseMentionValue(agent.agentId);
  const label = normaliseMentionValue(agent.label);
  const botNpub = normaliseMentionValue(agent.botNpub);
  if (
    structuredMentionIds.has(botNpub)
    || structuredMentionIds.has(agentId)
    || structuredMentionLabels.has(label)
    || structuredMentionLabels.has(agentId)
  ) {
    return true;
  }

  return plainMentionMatches(body, agent.agentId) || plainMentionMatches(body, agent.label);
}

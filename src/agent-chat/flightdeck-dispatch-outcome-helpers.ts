import type { AgentChatDispatchHistoryEntry } from './types';

type DispatchTrigger = 'chat' | 'task' | 'doc';
type DispatchAction = 'pipeline' | 'session';
type DispatchOutcome = 'queued' | 'launched' | 'suppressed' | 'ignored' | 'failed';

export function triggerForDispatchHistory(entry: AgentChatDispatchHistoryEntry): DispatchTrigger | null {
  if (entry.kind === 'chat') return 'chat';
  if (entry.kind === 'task' || entry.kind === 'flow' || entry.kind === 'review' || entry.kind === 'approval') return 'task';
  if (entry.kind === 'document') return 'doc';
  if (entry.kind === 'comment') {
    if (entry.bindingType === 'task') return 'task';
    if (entry.bindingType === 'document') return 'doc';
  }
  return null;
}

export function isPipelineDispatchLaunch(entry: AgentChatDispatchHistoryEntry): boolean {
  return Boolean(entry.pipelineRunId && entry.status !== 'suppressed' && entry.action.includes('pipeline_dispatch'));
}

export function outcomeForDispatchHistory(
  entry: AgentChatDispatchHistoryEntry,
  action: DispatchAction | null,
): DispatchOutcome {
  if (entry.status === 'failed' || entry.status === 'error' || entry.status === 'cancelled' || entry.action.includes('failed')) {
    return 'failed';
  }
  if (action) return 'launched';
  if (entry.status === 'suppressed' || entry.action.includes('suppressed') || Boolean(entry.suppressionReason)
    || typeof entry.details?.suppression_reason === 'string') return 'suppressed';
  return 'ignored';
}

export function outcomeKeyForDispatchHistory(entry: AgentChatDispatchHistoryEntry): string {
  const recordId = entry.recordId ?? entry.bindingId ?? 'unknown';
  if (entry.kind === 'chat' && entry.action === 'chat_dispatch') return `${entry.agentId}:${recordId}:session`;
  if (entry.action.includes('pipeline_')) return `${entry.agentId}:${recordId}:${entry.routeId ?? 'default'}:pipeline`;
  return `${entry.agentId}:${recordId}:${entry.action}`;
}

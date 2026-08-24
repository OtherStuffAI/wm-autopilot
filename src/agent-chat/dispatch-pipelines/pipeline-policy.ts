import type { AgentCapability, DispatchTriggerKind } from '../types';

export type DispatchPipelineVersionPolicy = 'latest';

export const DEFAULT_DISPATCH_PIPELINE_VERSION_POLICY: DispatchPipelineVersionPolicy = 'latest';

const BUILT_IN_DISPATCH_PIPELINES = new Set([
  'fd-agent-dispatch-chat',
  'fd-agent-dispatch-task-response',
  'fd-agent-dispatch-comment-response',
  'fd-document-invocation',
]);

const KNOWN_BUILT_IN_DISPATCH_GENERATED_IDS = new Map<string, string>([
  ['shared:7df6cda5438c', 'fd-agent-dispatch-chat'],
  ['shared:4e7e569c4c5f', 'fd-agent-dispatch-task-response'],
  ['shared:e4cd47744fb8', 'fd-agent-dispatch-comment-response'],
]);

export function normaliseDispatchPipelineVersionPolicy(
  value: string | null | undefined,
): DispatchPipelineVersionPolicy {
  return value === 'latest' ? 'latest' : DEFAULT_DISPATCH_PIPELINE_VERSION_POLICY;
}

export function normaliseBuiltInDispatchPipelineId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return KNOWN_BUILT_IN_DISPATCH_GENERATED_IDS.get(trimmed) ?? trimmed;
}

export function isBuiltInDispatchPipelineId(value: string | null | undefined): boolean {
  const normalised = normaliseBuiltInDispatchPipelineId(value);
  return Boolean(normalised && BUILT_IN_DISPATCH_PIPELINES.has(normalised));
}

export function stableDispatchPipelineIdForRoute(input: {
  triggerKind: DispatchTriggerKind;
  capability: AgentCapability;
}): string | null {
  if (input.triggerKind === 'chat' && input.capability === 'chat_intercept') {
    return 'fd-agent-dispatch-chat';
  }
  if (input.triggerKind === 'task' && input.capability === 'task_dispatch') {
    return 'fd-agent-dispatch-task-response';
  }
  if (input.triggerKind === 'document' && input.capability === 'task_dispatch') {
    return 'fd-document-invocation';
  }
  if (input.triggerKind === 'comment' && input.capability === 'comment_dispatch') {
    return 'fd-agent-dispatch-comment-response';
  }
  return null;
}

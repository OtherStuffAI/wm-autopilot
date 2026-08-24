import type {
  AgentDefinitionRecord,
  InboundCommentRecord,
  InboundTaskRecord,
} from '../agent-chat/types';
import {
  DEFAULT_TASK_DISPATCH_PROMPT_TEMPLATE,
  renderPromptTemplate,
} from '../agent-chat/prompt-templates';

function compactText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function formatRuntimeContextBlock(value: string | null | undefined): string {
  const trimmed = compactText(value);
  return trimmed ? `\n\nProfile workspace runtime context:\n${trimmed}` : '';
}

export function buildAgentWorkGoal(task: InboundTaskRecord): string {
  const title = compactText(task.title) || `Task ${task.taskId}`;
  const description = compactText(task.description) || '(no description provided)';
  const flowId = compactText(task.flowId) || '-';
  const flowRunId = compactText(task.flowRunId) || '-';
  const flowStep = compactText(task.flowStep) || '-';

  return [
    'I would like you to reflect and consider if you have adequately achieved the task.',
    'If the task has a flow, you should consider if you have met the flow step and correctly dispatched the next task.',
    'If you believe the task has been met and the next steps are all correctly handed off, then set nextAction to stop using the Wingman session metadata CLI (`bun clis/sessions.ts metadata-update --next-action stop`).',
    'Otherwise continue to work towards an answer.',
    `The task was: ${title} (task_id=${task.taskId}, flow_id=${flowId}, flow_run_id=${flowRunId}, flow_step=${flowStep}). Description: ${description}`,
  ].join(' ');
}

function buildScopeLineage(task: InboundTaskRecord): string {
  const values = [
    task.scopeL1Id,
    task.scopeL2Id,
    task.scopeL3Id,
    task.scopeL4Id,
    task.scopeL5Id,
  ].map((value) => compactText(value)).filter(Boolean);
  return values.length > 0 ? values.join(' > ') : '-';
}

export function buildTaskDispatchPrompt(params: {
  agent: AgentDefinitionRecord;
  task: InboundTaskRecord;
  dispatchReason: 'new task' | 'task updated';
  runtimeContext?: string | null;
}): string {
  const { task, dispatchReason, agent } = params;
  const flowId = compactText(task.flowId) || '-';
  const flowRunId = compactText(task.flowRunId) || '-';
  const flowStep = compactText(task.flowStep) || '-';
  const scopeId = compactText(task.scopeId) || '-';
  const scopeLineage = buildScopeLineage(task);
  const title = compactText(task.title) || `Task ${task.taskId}`;
  const description = compactText(task.description) || '(no description provided)';
  const prompt = renderPromptTemplate(agent.taskPromptTemplate || DEFAULT_TASK_DISPATCH_PROMPT_TEMPLATE, {
    dispatch_reason: dispatchReason,
    task_id: task.taskId,
    flow_id: flowId,
    flow_run_id: flowRunId,
    flow_step: flowStep,
    scope_id: scopeId,
    scope_lineage: scopeLineage,
    title,
    description,
  });
  return `${prompt}${formatRuntimeContextBlock(params.runtimeContext)}`;
}

export function buildTaskCommentDispatchPrompt(params: {
  agent: AgentDefinitionRecord;
  taskId: string;
  comment: InboundCommentRecord;
  commands: {
    sync: string;
    show: string;
    reply: string;
  };
  runtimeContext?: string | null;
}): string {
  const body = compactText(params.comment.body) || '[empty]';
  const prompt = [
    'Agent work comment advisory.',
    'Dispatch reason: task comment added.',
    `Agent id: ${params.agent.agentId}`,
    `Task id: ${params.taskId}`,
    `Comment id: ${params.comment.commentId}`,
    `Thread id: ${params.comment.parentCommentId ?? params.comment.commentId}`,
    `Sender npub: ${compactText(params.comment.senderNpub) || 'unknown'}`,
    `Comment status: ${params.comment.commentStatus}`,
    'Comment body:',
    body,
    '',
    'Yoke commands:',
    `- Sync workspace state: ${params.commands.sync}`,
    `- Review the task: ${params.commands.show}`,
    `- Reply in the current comment thread: ${params.commands.reply}`,
    '',
    'Instructions:',
    '- Sync first so you inspect the latest board state before replying.',
    '- Review the task and the new comment together.',
    '- Reply in the existing task comment thread, not in the Wingman chat transcript.',
    '- Confirm whether this comment changes the required next actions on the task.',
    '- If no further work is needed after replying, set nextAction to stop.',
  ].join('\n');
  return `${prompt}${formatRuntimeContextBlock(params.runtimeContext)}`;
}

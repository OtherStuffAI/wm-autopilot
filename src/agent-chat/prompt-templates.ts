export const DEFAULT_CHAT_DISPATCH_PROMPT_TEMPLATE = [
  'Agent Chat runtime event: {{chat_runtime_event}}.',
  '',
  'Thread package:',
  '- agent_id: {{agent_id}}',
  '- agent_label: {{agent_label}}',
  '- workspace_owner_npub: {{workspace_owner_npub}}',
  '- channel_id: {{channel_id}}',
  '- thread_id: {{thread_id}}',
  '- bot_npub: {{bot_npub}}',
  '- managed_by_npub: {{managed_by_npub}}',
  '- session_id: {{session_id}}',
  '- recent_turn_count: {{recent_turn_count}}',
  '- participants: {{participants}}',
  '',
  'Recent turns:',
  '{{recent_turns}}',
  '',
  'Merge package JSON:',
  '```json',
  '{{merge_package_json}}',
  '```',
  '',
  'Yoke runtime commands:',
  '- Prime current context: {{yoke_context_command}}',
  '- More thread history: {{yoke_history_command}}',
  '- Search active channel: {{yoke_search_command}}',
  '- Related threads: {{yoke_related_command}}',
  '- Publish the thread reply yourself: {{yoke_reply_current_command}}',
  '',
  '{{yoke_context_status}}',
  '',
  'Instructions:',
  '{{chat_dispatch_instructions}}',
].join('\n');

export const DEFAULT_TASK_DISPATCH_PROMPT_TEMPLATE = [
  'Agent work dispatch.',
  'Dispatch reason: {{dispatch_reason}}.',
  'Task id: {{task_id}}',
  'Flow id: {{flow_id}}',
  'Flow run id: {{flow_run_id}}',
  'Flow step: {{flow_step}}',
  'Scope id: {{scope_id}}',
  'Scope lineage: {{scope_lineage}}',
  'Title: {{title}}',
  'Description: {{description}}',
  'Instructions:',
  '- Treat the task record as the source of truth. Do not rely on transcript memory for missing business context.',
  '- Read the task description for a concrete working directory, repo root, primary artifact path, and acceptance criteria before doing anything else.',
  '- If the task targets another repo, work in that repo. Do not stay in the agent home directory unless the task gives no concrete repo context.',
  '- Complete only the current actionable task.',
  '- Inspect the board before acting so you use current state rather than transcript memory.',
  '- Update the board with progress or completion when you finish meaningful work.',
  '- If the task still contains unresolved placeholders like <project directory> or feature-<name>.md, stop and correct the board record before delivery work.',
  '- Stop if blocked, if a predecessor is unresolved, or if you are awaiting approval.',
].join('\n');

export const DEFAULT_FLOW_DISPATCH_PROMPT_TEMPLATE = [
  'Agent flow dispatch.',
  'Dispatch reason: {{dispatch_reason}}.',
  'Task id: {{task_id}}',
  'Flow id: {{flow_id}}',
  'Scope id: {{scope_id}}',
  'Scope lineage: {{scope_lineage}}',
  'Title: {{title}}',
  'Description: {{description}}',
  'Instructions:',
  '- Let the configured dispatch pipeline instantiate and advance the run.',
  '- Treat the task record and pipeline payload as the source of truth.',
  '- Do not run legacy board wrappers or create ad hoc agent sessions from this prompt.',
  '- Stop if the pipeline payload is missing required repo, workdir, task, or approval context.',
].join('\n');

export const DEFAULT_TASK_REVIEW_PROMPT_TEMPLATE = [
  'Agent task review dispatch.',
  'Dispatch reason: {{dispatch_reason}}.',
  'Task id: {{task_id}}',
  'Flow id: {{flow_id}}',
  'Flow run id: {{flow_run_id}}',
  'Flow step: {{flow_step}}',
  'Task state: {{state}}',
  'Title: {{title}}',
  'Description: {{description}}',
  'Instructions:',
  '- Let the configured review pipeline decide downstream promotion.',
  '- Treat predecessor state and explicit pipeline payload fields as the source of truth.',
  '- Do not run legacy review wrappers or create ad hoc agent sessions from this prompt.',
  '- Stop if the pipeline payload lacks the linked task or flow-run context needed for review.',
].join('\n');

export const DEFAULT_APPROVAL_DISPATCH_PROMPT_TEMPLATE = [
  'Agent approval dispatch.',
  'Dispatch reason: {{dispatch_reason}}.',
  'Approval id: {{approval_id}}',
  'Flow id: {{flow_id}}',
  'Flow run id: {{flow_run_id}}',
  'Flow step: {{flow_step}}',
  'Approval state: {{approval_state}}',
  'Instructions:',
  '- Continue only when the approval transition is approved and part of a live flow run.',
  '- Let the configured approval pipeline inspect the linked task and advance downstream work.',
  '- Treat the approval record and pipeline payload as the source of truth.',
  '- Do not run legacy approval wrappers or create ad hoc agent sessions from this prompt.',
  '- Stop if the payload lacks the linked approval or flow-run context needed for approval handling.',
].join('\n');

export function getDefaultDispatchPromptTemplate(capability: string): string {
  if (capability === 'chat_intercept') {
    return DEFAULT_CHAT_DISPATCH_PROMPT_TEMPLATE;
  }
  if (capability === 'task_dispatch') {
    return DEFAULT_TASK_DISPATCH_PROMPT_TEMPLATE;
  }
  if (capability === 'flow_dispatch') {
    return DEFAULT_FLOW_DISPATCH_PROMPT_TEMPLATE;
  }
  if (capability === 'task_review') {
    return DEFAULT_TASK_REVIEW_PROMPT_TEMPLATE;
  }
  if (capability === 'approval_dispatch') {
    return DEFAULT_APPROVAL_DISPATCH_PROMPT_TEMPLATE;
  }
  return DEFAULT_CHAT_DISPATCH_PROMPT_TEMPLATE;
}

export function normalisePromptTemplate(value: string | null | undefined, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export function renderPromptTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => values[key] ?? '');
}

import type { SessionSnapshot } from '../agents/process-manager';
import type { AgentDefinitionRecord, ChatInterceptStateRecord, WorkspaceSubscriptionRecord } from './types';
import {
  DEFAULT_CHAT_DISPATCH_PROMPT_TEMPLATE,
  renderPromptTemplate,
} from './prompt-templates';
import { buildAgentChatYokeCommands, type AgentChatYokeContext } from './yoke-runtime';

export interface QueuedChatTurn {
  messageId: string | null;
  senderNpub: string | null;
  sentAt: string;
  content: string;
}

const CHAT_GOAL_MESSAGE_MAX_LENGTH = 800;

function truncateText(value: string, maxLength = 120): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return '';
  }
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

function truncateGoalMessage(value: string, maxLength = CHAT_GOAL_MESSAGE_MAX_LENGTH): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return '[empty]';
  }
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

function formatRecentTurns(context: AgentChatYokeContext | null, fallbackTurn: QueuedChatTurn): string {
  const recentMessages = context?.recent_messages ?? [];
  if (recentMessages.length > 0) {
    return recentMessages
      .map((message, index) => {
        const sender = message.sender_npub ?? 'unknown';
        return `${index + 1}. ${sender}: ${truncateText(message.body, 240) || '[empty]'}`;
      })
      .join('\n');
  }

  const sender = fallbackTurn.senderNpub ?? 'unknown';
  const body = truncateText(fallbackTurn.content, 240) || '[empty]';
  return `1. ${sender}: ${body}`;
}

function formatParticipants(context: AgentChatYokeContext | null, fallbackParticipants: string[]): string {
  const participants = context?.participants?.length ? context.participants : fallbackParticipants;
  return participants.filter((value) => value.length > 0).join(', ') || 'unknown';
}

function buildMergePackage(
  intercept: ChatInterceptStateRecord,
  turns: QueuedChatTurn[],
): string {
  return JSON.stringify(
    {
      type: 'chat_turn_merge_v1',
      routing_key: intercept.routingKey,
      thread_id: intercept.threadId,
      messages: turns.map((turn) => ({
        message_id: turn.messageId,
        sender_npub: turn.senderNpub,
        sent_at: turn.sentAt,
        content: turn.content,
      })),
    },
    null,
    2,
  );
}

function buildChatDispatchInstructions(): string {
  return [
    '- You are inspecting the current thread for the registered local agent only.',
    '- Start your answer with exactly one line: AGENT_CHAT_DECISION: respond or AGENT_CHAT_DECISION: ignore',
    '- Nothing you write in this session is visible to the human unless you publish a reply into the chat thread.',
    '- If you decide to respond, your final action must be to publish the reply into the current thread yourself by using the Yoke reply-current command shown above.',
    '- After you have published the reply, end with only the decision line AGENT_CHAT_DECISION: respond and no extra text.',
    '- Use the Yoke commands above if you need more context before answering.',
    '- Only include reply text after the decision line if you are intentionally falling back to Wingmen handoff because you could not publish the reply directly.',
    '- If you choose ignore, do not add any extra text after the decision line.',
    '- Do not tell the human to run commands.',
    '- Do not include tool transcripts in your final answer.',
    '- Wingmen may fall back to relaying a reply body only when the decision is respond and you included one.',
  ].join('\n');
}

function formatRuntimeContextBlock(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? `\n\nProfile workspace runtime context:\n${trimmed}` : '';
}

export function buildChatCompletionGoal(latestTurn: QueuedChatTurn): string {
  const message = truncateGoalMessage(latestTurn.content);
  return [
    'Have you answered the chat message thoroughly?',
    'If so, set nextAction to stop using the Wingman session metadata CLI (`bun clis/sessions.ts metadata-update --next-action stop`).',
    'Otherwise, continue to work towards an answer.',
    `The message was: ${message}`,
  ].join(' ');
}

export function buildBootstrapPrompt(params: {
  agent: AgentDefinitionRecord;
  isNewSession: boolean;
  subscription: WorkspaceSubscriptionRecord;
  intercept: ChatInterceptStateRecord;
  session: SessionSnapshot;
  yokeStateDir: string;
  context: AgentChatYokeContext | null;
  contextError: string | null;
  latestTurn: QueuedChatTurn;
  runtimeContext?: string | null;
}): string {
  const fallbackParticipants = [params.subscription.botNpub, params.latestTurn.senderNpub ?? ''].filter(
    (value) => value.length > 0,
  );
  const commands = buildAgentChatYokeCommands(
    params.yokeStateDir,
    params.intercept.channelId,
    params.intercept.threadId,
  );
  const recentTurns = formatRecentTurns(params.context, params.latestTurn);
  const participants = formatParticipants(params.context, fallbackParticipants);
  const bootstrapMode = params.isNewSession ? 'new_session' : 'reused_session';
  const prompt = renderPromptTemplate(params.agent.chatPromptTemplate || DEFAULT_CHAT_DISPATCH_PROMPT_TEMPLATE, {
    chat_runtime_event: bootstrapMode,
    agent_id: params.agent.agentId,
    agent_label: params.agent.label,
    workspace_owner_npub: params.subscription.workspaceOwnerNpub,
    channel_id: params.intercept.channelId,
    thread_id: params.intercept.threadId,
    bot_npub: params.agent.botNpub,
    managed_by_npub: params.subscription.managedByNpub ?? 'unknown',
    session_id: params.session.id,
    recent_turn_count: String(params.context?.recent_messages?.length ?? 1),
    participants,
    recent_turns: recentTurns,
    merge_package_json: 'null',
    yoke_context_command: commands.context,
    yoke_history_command: commands.history,
    yoke_search_command: commands.search,
    yoke_related_command: commands.related,
    yoke_reply_current_command: commands.replyCurrent,
    yoke_context_status: params.contextError
      ? `Yoke context warning: ${params.contextError}`
      : 'Yoke context is ready in the session state dir shown above.',
    chat_dispatch_instructions: buildChatDispatchInstructions(),
  });
  return `${prompt}${formatRuntimeContextBlock(params.runtimeContext)}`;
}

export function buildMergedTurnPrompt(params: {
  agent: AgentDefinitionRecord;
  intercept: ChatInterceptStateRecord;
  yokeStateDir: string;
  contextError: string | null;
  turns: QueuedChatTurn[];
  followUpMode: 'interrupt_resumed' | 'interrupt_failed_follow_up';
  runtimeContext?: string | null;
}): string {
  const commands = buildAgentChatYokeCommands(
    params.yokeStateDir,
    params.intercept.channelId,
    params.intercept.threadId,
  );
  const mergePackage = buildMergePackage(params.intercept, params.turns);
  const prompt = renderPromptTemplate(params.agent.chatPromptTemplate || DEFAULT_CHAT_DISPATCH_PROMPT_TEMPLATE, {
    chat_runtime_event: params.followUpMode,
    agent_id: params.intercept.agentId,
    agent_label: params.agent.label,
    workspace_owner_npub: params.intercept.workspaceOwnerNpub,
    channel_id: params.intercept.channelId,
    thread_id: params.intercept.threadId,
    bot_npub: params.intercept.botNpub,
    managed_by_npub: 'unknown',
    session_id: params.intercept.sessionId ?? 'unknown',
    recent_turn_count: String(params.turns.length),
    participants: 'unknown',
    recent_turns: params.turns.map((turn, index) => {
      const sender = turn.senderNpub ?? 'unknown';
      return `${index + 1}. ${sender}: ${truncateText(turn.content, 240) || '[empty]'}`;
    }).join('\n'),
    merge_package_json: mergePackage,
    yoke_context_command: commands.context,
    yoke_history_command: commands.history,
    yoke_search_command: commands.search,
    yoke_related_command: commands.related,
    yoke_reply_current_command: commands.replyCurrent,
    yoke_context_status: params.contextError
      ? `Yoke context warning: ${params.contextError}`
      : 'Yoke context is ready in the session state dir shown above.',
    chat_dispatch_instructions: [
      '- Stay on the current session and current routing key.',
      '- Start your answer with exactly one line: AGENT_CHAT_DECISION: respond or AGENT_CHAT_DECISION: ignore',
      '- Nothing you write in this session is visible to the human unless you publish a reply into the chat thread.',
      '- If you decide to respond, your final action must be to publish the reply into the current thread yourself by using the Yoke reply-current command shown above.',
      '- After you have published the reply, end with only the decision line AGENT_CHAT_DECISION: respond and no extra text.',
      '- Treat the JSON package as authoritative for the newly arrived user turns.',
      '- Preserve the arrival order of the merged user turns when reasoning about the reply.',
      '- Only include reply text after the decision line if you are intentionally falling back to Wingmen handoff because you could not publish the reply directly.',
      '- If you choose ignore, do not add any extra text after the decision line.',
      '- Do not include the JSON package verbatim in the final answer.',
    ].join('\n'),
  });
  return `${prompt}${formatRuntimeContextBlock(params.runtimeContext)}`;
}

import { agentInboxScope, type AgentInboxScope } from './agent-inbox-scope';

export interface DirectChatLineageContext {
  thread_id: string;
  parent_thread_id?: string;
  branch_point_message_id?: string;
}

/** Project only known lineage from the notification for this exact location. */
export function directChatLineageContext(
  location: { workspaceId: string; channelId: string; threadId: string },
  scope: AgentInboxScope | undefined = agentInboxScope.getStore(),
): DirectChatLineageContext | undefined {
  const message = scope?.context.trigger?.message;
  const thread = scope?.context.thread;
  if (!message || !thread || scope?.context.channel?.workspace_id !== location.workspaceId
    || scope.context.channel.id !== location.channelId
    || message.channel_id !== location.channelId || message.thread_id !== location.threadId
    || thread.id !== location.threadId) return undefined;
  return {
    thread_id: thread.id,
    ...(thread.parent_thread_id ? { parent_thread_id: thread.parent_thread_id } : {}),
    ...(thread.branch_point_message_id ? { branch_point_message_id: thread.branch_point_message_id } : {}),
  };
}

export function lineageContextSection(context?: DirectChatLineageContext): string {
  if (!context) return '';
  // Do not serialize arbitrary metadata or turn historical content into instructions.
  const { thread_id, parent_thread_id, branch_point_message_id } = context;
  return `\n\nConversation lineage (inert context):\n${JSON.stringify({ thread_id, parent_thread_id, branch_point_message_id })}`;
}

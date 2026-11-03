import { AgentInboxError, classifyAgentNotificationOnly, readAgentAccessProfile, type AgentInboxRequestContext } from './agent-inbox-client';

export const NOTIFICATION_ONLY_PROFILE = 'notification_only';
export const CEILING_UNVERIFIED_CODE = 'agent_inbox_ceiling_unverified';

export type CeilingResult =
  | { status: 'verified' }
  | { status: 'halt' | 'backoff'; code: string; message: string };

/**
 * Ensures Tower holds this bot under its notification-only ceiling in the workspace BEFORE any inbox subscription or
 * dispatch: read the existing access profile, self-classify through the existing route when absent, and accept only a
 * Tower response that confirms the ceiling. Anything else is refused; there is never a broader fallback.
 */
export async function ensureNotificationOnlyCeiling(
  context: AgentInboxRequestContext,
  client: { read: typeof readAgentAccessProfile; classify: typeof classifyAgentNotificationOnly } = {
    read: readAgentAccessProfile, classify: classifyAgentNotificationOnly,
  },
): Promise<CeilingResult> {
  try {
    if ((await client.read(context))?.profile === NOTIFICATION_ONLY_PROFILE) return { status: 'verified' };
    if ((await client.classify(context))?.profile === NOTIFICATION_ONLY_PROFILE) return { status: 'verified' };
    return { status: 'halt', code: CEILING_UNVERIFIED_CODE, message: 'Tower did not confirm the notification-only ceiling for this bot; dispatch stays stopped.' };
  } catch (error) {
    const inboxError = error instanceof AgentInboxError ? error : null;
    const message = `The notification-only ceiling could not be verified, so dispatch stays stopped: ${error instanceof Error ? error.message : String(error)}`;
    // Authorization refusals (for example a non-agent identity) need an operator; transient failures retry. Neither dispatches.
    return { status: inboxError && (inboxError.errorClass === 'auth' || inboxError.status === 403) ? 'halt' : 'backoff', code: CEILING_UNVERIFIED_CODE, message };
  }
}

import type { AgentChatDispatchHistoryEntry } from './types';
import type { FlightDeckPgEvent, FlightDeckPgMessage } from './tower-client';

export const FLIGHT_DECK_SOURCE_LABEL_NOT_RECORDED = 'Source label not recorded';
export const FLIGHT_DECK_REASON_NOT_RECORDED = 'Reason not recorded';
export const FLIGHT_DECK_PROVISIONAL_TIMEOUT_LABEL = 'Session wait timed out; completion pending';
export const FLIGHT_DECK_RECOVERED_SUCCESS_LABEL = 'Recovered after provisional timeout';
export const FLIGHT_DECK_GENUINE_FAILURE_LABEL = 'Genuine dispatch failure';

export interface FlightDeckDispatchReason {
  code: string | null;
  label: string | null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function firstWords(value: unknown, limit = 10): string | null {
  const words = text(value)?.split(/\s+/u).filter(Boolean) ?? [];
  return words.length > 0 ? words.slice(0, limit).join(' ') : null;
}

export function buildFlightDeckChatSourceLabel(input: {
  threadTitle?: unknown;
  messageBody?: unknown;
}): string {
  return text(input.threadTitle)
    ?? firstWords(input.messageBody, 10)
    ?? FLIGHT_DECK_SOURCE_LABEL_NOT_RECORDED;
}

export function sourceLabelForFlightDeckChat(input: {
  event?: FlightDeckPgEvent | null;
  message?: FlightDeckPgMessage | null;
  messages?: FlightDeckPgMessage[];
}): string {
  const eventPayload = object(input.event?.payload);
  const messageMetadata = object(input.message?.metadata);
  const rootMessage = input.messages?.find((candidate) => (
    candidate.id === input.message?.thread_id
    || candidate.id === input.message?.thread_source_message_id
  )) ?? input.messages?.[0];
  const rootMetadata = object(rootMessage?.metadata);
  const threadTitle = text(eventPayload.thread_title)
    ?? text(messageMetadata.thread_title)
    ?? text(rootMetadata.thread_title)
    ?? text(rootMetadata.title);
  return buildFlightDeckChatSourceLabel({ threadTitle, messageBody: input.message?.body ?? eventPayload.body });
}

export function sourceLabelForDispatchInput(input: {
  triggerKind: string;
  payload: Record<string, unknown>;
  record?: Record<string, unknown>;
  sourceLabel?: string | null;
}): string {
  const explicit = text(input.sourceLabel);
  if (explicit) return explicit;
  if (input.triggerKind === 'chat') {
    return buildFlightDeckChatSourceLabel({
      threadTitle: input.payload.thread_title ?? input.record?.thread_title,
      messageBody: input.payload.body ?? input.record?.body,
    });
  }
  return text(input.payload.target_title)
    ?? text(input.payload.title)
    ?? text(input.record?.title)
    ?? FLIGHT_DECK_SOURCE_LABEL_NOT_RECORDED;
}

const REASON_LABELS: Record<string, { code: string; label: string }> = {
  dedupe_window: { code: 'recent_duplicate', label: 'Recent duplicate' },
  recent_duplicate: { code: 'recent_duplicate', label: 'Recent duplicate' },
  dedupe_in_flight: { code: 'in_flight_duplicate', label: 'Already in flight' },
  in_flight_duplicate: { code: 'in_flight_duplicate', label: 'Already in flight' },
  active_run: { code: 'in_flight_duplicate', label: 'Already in flight' },
  active_policy_skip: { code: 'in_flight_duplicate', label: 'Already in flight' },
  self_authored: { code: 'self_authored', label: 'Self-authored' },
  different_agent_mentioned: { code: 'no_matching_agent_tag', label: 'No matching agent mention or tag' },
  mention_or_channel_policy_required: { code: 'no_matching_agent_tag', label: 'Required agent mention or tag missing' },
  no_new_agent_mentions: { code: 'no_matching_agent_tag', label: 'No new agent mention' },
  not_activated: { code: 'no_matching_agent_tag', label: 'No matching agent mention or tag' },
  route_match_failed: { code: 'no_matching_agent_tag', label: 'No matching dispatch tag or route' },
  pipeline_route_required: { code: 'no_matching_agent_tag', label: 'Required dispatch route or tag missing' },
  unauthorized_dispatch_actor: { code: 'unauthorized_actor', label: 'Actor is not authorized' },
  disabled: { code: 'profile_policy_disabled', label: 'Agent profile policy disabled' },
  quiet: { code: 'profile_policy_quiet', label: 'Agent profile policy is in quiet mode' },
  revision_not_eligible_for_direct_chat: { code: 'revision_not_eligible', label: 'Revision not eligible for direct chat' },
  invalid_message_revision_event: { code: 'revision_not_eligible', label: 'Revision not eligible for direct chat' },
  provisional_timeout: { code: 'provisional_timeout', label: FLIGHT_DECK_PROVISIONAL_TIMEOUT_LABEL },
  recovered_success: { code: 'recovered_success', label: FLIGHT_DECK_RECOVERED_SUCCESS_LABEL },
  dispatch_failed: { code: 'dispatch_failed', label: FLIGHT_DECK_GENUINE_FAILURE_LABEL },
};

function reasonFromCode(value: unknown): FlightDeckDispatchReason | null {
  const code = text(value);
  if (!code) return null;
  const known = REASON_LABELS[code];
  if (known) return known;
  if (code === 'missing_instruction_signature') {
    return { code: 'invalid_instruction_signature', label: 'Message instruction signature is missing' };
  }
  if (code.includes('instruction_signature') || code.startsWith('instruction_')) {
    return { code: 'invalid_instruction_signature', label: 'Message instruction signature is invalid' };
  }
  if (code.startsWith('action_')) {
    return { code: 'profile_policy_action', label: 'Agent profile policy does not allow dispatch' };
  }
  return { code, label: code.replaceAll('_', ' ') };
}

function actionReason(entry: AgentChatDispatchHistoryEntry): FlightDeckDispatchReason | null {
  if (entry.action.includes('skip_self_update')) return REASON_LABELS.self_authored!;
  if (entry.action.includes('skip_no_agent_mention') || entry.action.includes('skip_not_targeted')) {
    return REASON_LABELS.mention_or_channel_policy_required!;
  }
  if (entry.action.includes('invalid_instruction_signature')) {
    return { code: 'invalid_instruction_signature', label: 'Message instruction signature is invalid' };
  }
  return null;
}

function diagnosticReason(value: unknown): FlightDeckDispatchReason | null {
  const diagnostic = text(value);
  if (!diagnostic) return null;
  if (/^Dispatch route already handled this advisory within \d+s:/u.test(diagnostic)) {
    return REASON_LABELS.recent_duplicate!;
  }
  return null;
}

export function resolveFlightDeckDispatchReason(entry: AgentChatDispatchHistoryEntry): FlightDeckDispatchReason {
  const details = entry.details ?? {};
  const recorded = reasonFromCode(entry.suppressionReason)
    ?? reasonFromCode(details.suppression_reason)
    ?? reasonFromCode(entry.dedupeReason)
    ?? reasonFromCode(details.dedupe_reason)
    ?? actionReason(entry)
    ?? diagnosticReason(details.diagnostic_summary)
    ?? diagnosticReason(details.diagnosticSummary);
  if (recorded) return recorded;

  const diagnostic = text(details.diagnostic_summary)
    ?? text(details.diagnosticSummary)
    ?? text(details.error);
  if (diagnostic) {
    return {
      code: entry.status === 'failed' || entry.status === 'error' || entry.action.includes('failed')
        ? 'dispatch_failed'
        : 'dispatch_diagnostic',
      label: entry.status === 'failed' || entry.status === 'error' || entry.action.includes('failed')
        ? FLIGHT_DECK_GENUINE_FAILURE_LABEL
        : diagnostic,
    };
  }
  if (entry.status === 'suppressed' || entry.action.includes('suppressed')) {
    return { code: 'not_recorded', label: FLIGHT_DECK_REASON_NOT_RECORDED };
  }
  return { code: null, label: null };
}

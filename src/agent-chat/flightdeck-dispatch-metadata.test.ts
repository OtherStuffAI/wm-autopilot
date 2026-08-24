import { describe, expect, test } from 'bun:test';

import {
  buildFlightDeckChatSourceLabel,
  resolveFlightDeckDispatchReason,
  sourceLabelForFlightDeckChat,
} from './flightdeck-dispatch-metadata';

function suppressed(reason: string) {
  return resolveFlightDeckDispatchReason({
    at: '', kind: 'chat', action: 'chat_pipeline_suppressed', agentId: 'pipeline',
    sessionId: null, recordId: 'message-1', status: 'suppressed', suppressionReason: reason,
  });
}

describe('Flight Deck dispatch metadata', () => {
  test('normalises required diagnostic families to stable reason contracts', () => {
    expect(suppressed('dedupe_window')).toEqual({ code: 'recent_duplicate', label: 'Recent duplicate' });
    expect(suppressed('dedupe_in_flight')).toEqual({ code: 'in_flight_duplicate', label: 'Already in flight' });
    expect(suppressed('self_authored')).toEqual({ code: 'self_authored', label: 'Self-authored' });
    expect(suppressed('mention_or_channel_policy_required')).toEqual({ code: 'no_matching_agent_tag', label: 'Required agent mention or tag missing' });
    expect(suppressed('unauthorized_dispatch_actor')).toEqual({ code: 'unauthorized_actor', label: 'Actor is not authorized' });
    expect(suppressed('missing_instruction_signature')).toEqual({ code: 'invalid_instruction_signature', label: 'Message instruction signature is missing' });
    expect(suppressed('instruction_body_mismatch')).toEqual({ code: 'invalid_instruction_signature', label: 'Message instruction signature is invalid' });
    expect(suppressed('revision_not_eligible_for_direct_chat')).toEqual({ code: 'revision_not_eligible', label: 'Revision not eligible for direct chat' });
    expect(suppressed('quiet')).toEqual({ code: 'profile_policy_quiet', label: 'Agent profile policy is in quiet mode' });
    expect(suppressed('provisional_timeout')).toEqual({
      code: 'provisional_timeout', label: 'Session wait timed out; completion pending',
    });
    expect(suppressed('recovered_success')).toEqual({
      code: 'recovered_success', label: 'Recovered after provisional timeout',
    });
    expect(suppressed('dispatch_failed')).toEqual({ code: 'dispatch_failed', label: 'Genuine dispatch failure' });
  });

  test('does not invent a specific cause for evidence-free suppressed rows', () => {
    expect(resolveFlightDeckDispatchReason({
      at: '', kind: 'chat', action: 'chat_pipeline_suppressed', agentId: 'pipeline',
      sessionId: null, recordId: 'message-1', status: 'suppressed',
    })).toEqual({ code: 'not_recorded', label: 'Reason not recorded' });
  });

  test('recognises durable duplicate diagnostics from historical rows', () => {
    expect(resolveFlightDeckDispatchReason({
      at: '', kind: 'chat', action: 'chat_pipeline_suppressed', agentId: 'pipeline',
      sessionId: null, recordId: 'message-1', status: 'suppressed',
      details: { diagnostic_summary: 'Dispatch route already handled this advisory within 300s: run-1' },
    })).toEqual({ code: 'recent_duplicate', label: 'Recent duplicate' });
  });

  test('prefers thread titles and otherwise truncates chat bodies to ten words', () => {
    expect(buildFlightDeckChatSourceLabel({
      threadTitle: 'Dispatch review',
      messageBody: 'This body should not become the label',
    })).toBe('Dispatch review');
    expect(buildFlightDeckChatSourceLabel({
      messageBody: 'one two three four five six seven eight nine ten eleven twelve',
    })).toBe('one two three four five six seven eight nine ten');
    expect(sourceLabelForFlightDeckChat({
      message: { id: 'message-2', thread_id: 'message-1', body: 'fallback body' },
      messages: [
        { id: 'message-1', metadata: { thread_title: 'Authoritative thread title' } },
        { id: 'message-2', thread_id: 'message-1', body: 'fallback body' },
      ],
    })).toBe('Authoritative thread title');
  });
});

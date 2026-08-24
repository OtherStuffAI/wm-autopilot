import { describe, expect, test } from 'bun:test';

import { parseAgentChatReply } from './session-runtime-decision';

describe('parseAgentChatReply', () => {
  test('parses the canonical decision header', () => {
    const parsed = parseAgentChatReply('AGENT_CHAT_DECISION: respond\nHello from Wingmen.');
    expect(parsed).toEqual({
      decision: 'respond',
      replyBody: 'Hello from Wingmen.',
    });
  });

  test('accepts natural-language respond fallback on the first line', () => {
    const parsed = parseAgentChatReply('I should respond\nHello from Wingmen.');
    expect(parsed).toEqual({
      decision: 'respond',
      replyBody: 'Hello from Wingmen.',
    });
  });

  test('accepts natural-language ignore fallback on the first line', () => {
    const parsed = parseAgentChatReply('I should ignore');
    expect(parsed).toEqual({
      decision: 'ignore',
      replyBody: '',
    });
  });

  test('accepts a bare respond decision with no inline handoff body', () => {
    const parsed = parseAgentChatReply('AGENT_CHAT_DECISION: respond');
    expect(parsed).toEqual({
      decision: 'respond',
      replyBody: '',
    });
  });

  test('parses a trailing explicit decision line after Codex transcript output', () => {
    const parsed = parseAgentChatReply([
      'Ran bun mycode/yoke.js chat reply-current --body "done"',
      '{"status":"sent"}',
      '',
      '• AGENT_CHAT_DECISION: respond',
    ].join('\n'));

    expect(parsed).toEqual({
      decision: 'respond',
      replyBody: '',
    });
  });
});

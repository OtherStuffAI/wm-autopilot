import { describe, expect, test } from 'bun:test';
import {
  buildDirectChatBootstrapPrompt, buildDirectChatClientRequestId, buildDirectChatFollowUpPrompt,
  buildDirectChatTurnId, channelDirectChatConfig, hasCanonicalNpubMention, hasInternalAgentDirectRecipient,
  isAgentDirectMessageEligible, isImplicitTwoPartyDirectMessage, orderDirectChatMessages,
  buildDirectChatRoutingKey,
  selectUndeliveredActionableMessages,
} from './direct-chat-contract';

describe('Agent Direct Chat contract', () => {
  const messages = orderDirectChatMessages([
    { id: 'm2', body: 'second', created_at: '2026-01-01T00:00:02Z', created_by_actor_npub: 'npub1human', created_by_actor_label: 'Pete' },
    { id: 'm1', body: '@Example Agent first', created_at: '2026-01-01T00:00:01Z', created_by_actor_npub: 'npub1human', created_by_actor_label: 'Pete', metadata: { mentions: [{ type: 'agent', npub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg', label: 'Example Agent' }] } },
    { id: 'a1', body: 'reply', created_at: '2026-01-01T00:00:03Z', created_by_actor_npub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg', created_by_actor_label: 'Rick' },
  ]);

  test('requires canonical npub mention metadata and orders authoritative history', () => {
    expect(messages.map((message) => message.messageId)).toEqual(['m1', 'm2', 'a1']);
    expect(hasCanonicalNpubMention(messages[0]!, 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg')).toBe(true);
    expect(hasCanonicalNpubMention({ ...messages[0]!, mentions: [] }, 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg')).toBe(false);
  });

  test('routes canonical npubs independently of actor presentation type', () => {
    const base = messages[0]!;
    for (const type of ['agent', 'person', 'actor', '']) {
      expect(hasCanonicalNpubMention({ ...base, mentions: [{ type, npub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg', actorId: 'actor-exampleAgent', label: 'Example Agent' }] }, 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg')).toBe(true);
    }
    expect(hasCanonicalNpubMention({ ...base, mentions: [{ type: 'agent', npub: 'npub1other', actorId: null, label: 'Other' }] }, 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg')).toBe(false);
    expect(hasCanonicalNpubMention({ ...base, message: '@Example Agent', mentions: [] }, 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg')).toBe(false);
  });

  test('routes an unmentioned child message through its internal Agent Direct recipient', () => {
    const botNpub = 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg';
    const [childMessage] = orderDirectChatMessages([{
      id: 'child-message',
      thread_id: 'child-thread',
      body: 'Try a different approach',
      created_at: '2026-01-01T00:00:01Z',
      created_by_actor_npub: 'npub1human',
      metadata: { agent_direct_recipient_npub: botNpub },
    }]);

    expect(childMessage!.mentions).toEqual([]);
    expect(hasInternalAgentDirectRecipient(childMessage!, botNpub)).toBe(true);
    expect(isAgentDirectMessageEligible({ id: 'channel-1', kind: 'channel' }, childMessage!, botNpub)).toBe(true);
    expect(isAgentDirectMessageEligible({ id: 'channel-1', kind: 'channel' }, childMessage!, 'npub1other')).toBe(false);
    expect(isAgentDirectMessageEligible({ id: 'channel-1', kind: 'channel' }, { ...childMessage!, inherited: true }, botNpub)).toBe(false);
  });

  test('recognises only an authored strict two-party DM as implicit activation', () => {
    const strictDm = { id: 'dm', kind: 'dm', participant_npubs: ['npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg', 'npub1human'] };
    expect(isImplicitTwoPartyDirectMessage(strictDm, 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg', 'npub1human')).toBe(true);
    expect(isImplicitTwoPartyDirectMessage(strictDm, 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg', 'npub1outsider')).toBe(false);
    expect(isImplicitTwoPartyDirectMessage({ ...strictDm, participant_npubs: ['npub1human', 'npub1other'] }, 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg', 'npub1human')).toBe(false);
    expect(isImplicitTwoPartyDirectMessage({ ...strictDm, participant_npubs: ['npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg', 'npub1human', 'npub1other'] }, 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg', 'npub1human')).toBe(false);
    expect(isImplicitTwoPartyDirectMessage({ ...strictDm, kind: 'channel' }, 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg', 'npub1human')).toBe(false);
  });

  test('treats absent and legacy false channel settings as Direct enabled with context fallback', () => {
    expect(channelDirectChatConfig({ id: 'c1', metadata: {} })).toEqual({ enabled: true, contextPrompt: '' });
    expect(channelDirectChatConfig({ id: 'c2', metadata: { contextPrompt: 'Legacy context' } })).toEqual({ enabled: true, contextPrompt: 'Legacy context' });
    expect(channelDirectChatConfig({ id: 'c3', metadata: { basePrompt: 'Base', agent_chat: { context_prompt: 'Direct' } } })).toEqual({ enabled: true, contextPrompt: 'Direct' });
    expect(channelDirectChatConfig({ id: 'c4', metadata: { agent_chat: { enabled: false } } })).toEqual({ enabled: true, contextPrompt: '' });
  });

  test('selects only undelivered human deltas', () => {
    expect(selectUndeliveredActionableMessages(messages, { lastHumanMessageIdDelivered: 'm1' } as never, 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg').map((message) => message.messageId)).toEqual(['m2']);
  });

  test('keeps an explicit canonical self-mention actionable while filtering ordinary agent output', () => {
    const botNpub = 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg';
    const selfMention = {
      ...messages[2]!,
      messageId: 'a2',
      message: '@Example Agent start a new turn',
      mentions: [{ type: 'agent', npub: botNpub, actorId: 'actor-exampleAgent', label: 'Example Agent' }],
    };
    expect(selectUndeliveredActionableMessages(
      [...messages, selfMention],
      { lastHumanMessageIdDelivered: 'm2' } as never,
      botNpub,
    ).map((message) => message.messageId)).toEqual(['a2']);
  });

  test('builds readable bootstrap and checkpointed follow-up envelopes', () => {
    const intercept = { routingKey: 'route', channelId: 'c1', threadId: 't1', botNpub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg', towerServiceNpub: 'npub1tower', workspaceId: 'w1' } as never;
    const subscription = { towerServiceNpub: 'npub1tower', workspaceId: 'w1' } as never;
    const bootstrap = buildDirectChatBootstrapPrompt({ contextPrompt: 'Project context', subscription, intercept, scopeId: 's1', history: messages, nextMessages: [messages[0]!] });
    expect(bootstrap).toContain('flightdeck_agent_direct_bootstrap_v1');
    expect(bootstrap).toContain('polished response using GitHub-Flavored Markdown');
    expect(bootstrap).toContain('normal final response is published verbatim to Flight Deck');
    expect(bootstrap).toContain('do not add a wrapper or envelope');
    expect(bootstrap).toContain('or enclose the whole response in a code fence');
    expect(bootstrap).not.toContain('FLIGHTDECK_REPLY_BEGIN');
    expect(bootstrap.indexOf('# Metadata')).toBeLessThan(bootstrap.indexOf('# History'));
    expect(bootstrap.indexOf('# History')).toBeLessThan(bootstrap.indexOf('# Prompt'));
    expect(bootstrap).toContain('"tower_service_npub": "npub1tower"');
    expect(bootstrap).toContain('## 2026-01-01T00:00:02Z · Pete · m2');
    expect(bootstrap).toContain('# Prompt\n\n@Example Agent first');
    expect(bootstrap.match(/@Example Agent first/g)).toHaveLength(1);

    const followUp = buildDirectChatFollowUpPrompt({ routingKey: 'route', threadId: 't1', history: messages,
      actionableMessages: [{ ...messages[1]!, message: 'Carry On', attachments: [{ id: 'file-1', filename: 'brief.pdf', content_type: 'application/pdf', storage_object_id: 'object-1' }], mentions: messages[0]!.mentions }],
      historyCheckpointMessageId: 'm1' });
    expect(followUp).toContain('polished response using GitHub-Flavored Markdown');
    expect(followUp).toContain('published verbatim to Flight Deck');
    expect(followUp).not.toContain('FLIGHTDECK_REPLY_BEGIN');
    expect(followUp).not.toContain('# Metadata');
    expect(followUp).toContain('# History');
    expect(followUp).toContain('## 2026-01-01T00:00:03Z · Rick · a1');
    expect(followUp).not.toContain(' · m1');
    expect(followUp).toContain('# Prompt\n\nCarry On\n\nMessage: m2 · 2026-01-01T00:00:02Z');
    expect(followUp).toContain('brief.pdf · application/pdf · storage://object-1 · id:file-1');
    for (const repeatedField of ['user_id', 'user_npub', 'owning_thread_id', '\"mentions\"', '\"attachments\"', '\"inherited\"']) {
      expect(followUp).not.toContain(repeatedField);
    }
    expect(followUp).not.toContain('Prompt record metadata');
    expect(followUp).not.toContain('npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg');
  });

  test('renders no missing history and fails closed on an inconsistent checkpoint', () => {
    const noHistory = buildDirectChatFollowUpPrompt({ routingKey: 'route', threadId: 't1', history: messages,
      actionableMessages: [{ ...messages[2]!, messageId: 'm3', message: 'Carry On' }], historyCheckpointMessageId: 'a1' });
    expect(noHistory).toContain('# History\n\n_No missing history._\n\n# Prompt\n\nCarry On');
    expect(() => buildDirectChatFollowUpPrompt({ routingKey: 'route', threadId: 't1', history: messages,
      actionableMessages: [messages[1]!], historyCheckpointMessageId: 'missing' })).toThrow('absent from the authoritative');
  });

  test('materially reduces database-shaped transcript noise', () => {
    const history = Array.from({ length: 8 }, (_, index) => ({
      ...messages[index % messages.length]!,
      messageId: `message-${index}-${'a'.repeat(28)}`,
      userId: `actor-${index}-${'b'.repeat(30)}`,
      owningThreadId: `thread-${'c'.repeat(29)}`,
      message: `Message body ${index}`,
      attachments: [],
    }));
    const prompt = { ...messages[0]!, messageId: 'actionable-message', message: 'Carry On' };
    const compact = buildDirectChatFollowUpPrompt({
      routingKey: 'route',
      threadId: 'thread',
      history: [...history, prompt],
      actionableMessages: [prompt],
    });
    const databaseShaped = JSON.stringify(history.map((message) => ({
      message_id: message.messageId,
      user_id: message.userId,
      user_npub: message.userNpub,
      created_at: message.createdAt,
      message: message.message,
      attachments: message.attachments,
      mentions: message.mentions,
      inherited: message.inherited,
      owning_thread_id: message.owningThreadId,
    })), null, 2);

    expect(compact.length).toBeLessThan(databaseShaped.length * 0.6);
    expect(compact).not.toContain('[]');
    expect(compact).not.toContain('false');
  });

  test('keeps inherited branch history inert even when it mentions the routed agent', () => {
    const botNpub = 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg';
    const branched = orderDirectChatMessages([
      {
        id: 'parent-instruction',
        thread_id: 'parent-thread',
        owning_thread_id: 'parent-thread',
        inherited: true,
        body: '@Example Agent do the old thing',
        created_at: '2026-01-01T00:00:01Z',
        created_by_actor_npub: 'npub1human',
        mentions: [{ type: 'agent', npub: botNpub, label: 'Example Agent' }],
      },
      {
        id: 'child-instruction',
        thread_id: 'child-thread',
        owning_thread_id: 'child-thread',
        inherited: false,
        body: '@Example Agent do the new thing',
        created_at: '2026-01-01T00:00:02Z',
        created_by_actor_npub: 'npub1human',
        mentions: [{ type: 'agent', npub: botNpub, label: 'Example Agent' }],
      },
    ]);

    expect(selectUndeliveredActionableMessages(branched, null, botNpub).map((message) => message.messageId))
      .toEqual(['child-instruction']);
    expect(buildDirectChatTurnId('child-route', ['child-instruction']))
      .not.toBe(buildDirectChatTurnId('child-route', ['parent-instruction', 'child-instruction']));
  });

  test('derives stable turn and publication ids', () => {
    const turn = buildDirectChatTurnId('route', ['m1', 'm2']);
    expect(turn).toBe(buildDirectChatTurnId('route', ['m1', 'm2']));
    expect(buildDirectChatClientRequestId('route', turn)).toMatch(/^agentdirect:[a-f0-9]{24}:[a-f0-9]{32}$/);
    expect(buildDirectChatRoutingKey({ towerServiceNpub: 'tower', workspaceId: 'workspace', channelId: 'channel', threadId: 'thread', agentNpub: 'exampleAgent' }))
      .toBe('agent-direct:v1:tower:workspace:channel:thread:exampleAgent');
  });
});

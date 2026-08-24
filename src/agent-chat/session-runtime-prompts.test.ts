import { describe, expect, test } from 'bun:test';

import { buildBootstrapPrompt, buildChatCompletionGoal, buildMergedTurnPrompt } from './session-runtime-prompts';

describe('Agent chat prompts', () => {
  test('bootstrap prompt states that the agent must publish the thread reply itself', () => {
    const prompt = buildBootstrapPrompt({
      agent: {
        agentId: 'agent_EXAMPLE_AGENT',
        label: 'Wingman 21',
        botNpub: 'npub1bot',
        workspaceOwnerNpub: 'npub1workspace',
        groupNpubs: ['npub1group'],
        workingDirectory: '/tmp/exampleAgent',
        capabilities: ['chat_intercept'],
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        managedByNpub: 'npub1manager',
      },
      isNewSession: true,
      subscription: {
        subscriptionId: 'sub-1',
        workspaceOwnerNpub: 'npub1workspace',
        backendBaseUrl: 'https://tower.example.com',
        botNpub: 'npub1bot',
        sourceAppNpub: 'npub1source',
        wsKeyNpub: null,
        wsKeyStatus: 'active',
        groupKeyStatus: 'active',
        sseStatus: 'connected',
        healthStatus: 'healthy',
        triggerConfigRecordId: null,
        lastSseEventId: null,
        lastAuthOkAt: null,
        lastGroupRefreshAt: null,
        lastErrorCode: null,
        lastErrorAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        managedByNpub: 'npub1manager',
        wsKeyBlobJson: null,
        wrappedGroupKeysJson: null,
        lastAuthResult: null,
        lastGroupRefreshResult: null,
        lastRecordPullResult: null,
        lastDecryptResult: null,
        lastRoutingResult: null,
        lastSseEvent: null,
        recentSseEvents: [],
        recentDispatches: [],
        lastSuccessfulStartupReloadAt: null,
      },
      intercept: {
        routingKey: 'routing-key',
        subscriptionId: 'sub-1',
        agentId: 'agent_EXAMPLE_AGENT',
        sessionId: 'session-1',
        sessionClass: 'chat',
        workspaceOwnerNpub: 'npub1workspace',
        sourceAppNpub: 'npub1source',
        channelId: 'channel-1',
        threadId: 'thread-1',
        botNpub: 'npub1bot',
        lastMessageIdSeen: null,
        pendingMessageCount: 0,
        state: 'pending',
        lastDecision: 'pending',
        lastActivityAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      session: {
        id: 'session-1',
        agent: 'codex',
        port: 0,
        name: 'Agent Chat',
        status: 'running',
        startedAt: new Date().toISOString(),
        command: [],
        workingDirectory: '/tmp/exampleAgent',
        logs: [],
      },
      yokeStateDir: '/tmp/state',
      context: null,
      contextError: null,
      latestTurn: {
        messageId: 'msg-1',
        senderNpub: 'npub1human',
        sentAt: new Date().toISOString(),
        content: 'Hello',
      },
    });

    expect(prompt).toContain('Nothing you write in this session is visible to the human unless you publish a reply into the chat thread.');
    expect(prompt).toContain('your final action must be to publish the reply into the current thread yourself by using the Yoke reply-current command shown above.');
    expect(prompt).toContain('After you have published the reply, end with only the decision line AGENT_CHAT_DECISION: respond and no extra text.');
  });

  test('merged prompt states that the agent must publish the reply back into the same thread', () => {
    const prompt = buildMergedTurnPrompt({
      agent: {
        agentId: 'agent_EXAMPLE_AGENT',
        label: 'Wingman 21',
        botNpub: 'npub1bot',
        workspaceOwnerNpub: 'npub1workspace',
        groupNpubs: ['npub1group'],
        workingDirectory: '/tmp/exampleAgent',
        capabilities: ['chat_intercept'],
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        managedByNpub: 'npub1manager',
        chatPromptTemplate: '',
        taskPromptTemplate: '',
      },
      intercept: {
        routingKey: 'routing-key',
        subscriptionId: 'sub-1',
        agentId: 'agent_EXAMPLE_AGENT',
        sessionId: 'session-1',
        sessionClass: 'chat',
        workspaceOwnerNpub: 'npub1workspace',
        sourceAppNpub: 'npub1source',
        channelId: 'channel-1',
        threadId: 'thread-1',
        botNpub: 'npub1bot',
        lastMessageIdSeen: null,
        pendingMessageCount: 0,
        state: 'active',
        lastDecision: 'pending',
        lastActivityAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      yokeStateDir: '/tmp/state',
      contextError: null,
      turns: [
        {
          messageId: 'msg-1',
          senderNpub: 'npub1human',
          sentAt: new Date().toISOString(),
          content: 'Follow up',
        },
      ],
      followUpMode: 'interrupt_failed_follow_up',
    });

    expect(prompt).toContain('Nothing you write in this session is visible to the human unless you publish a reply into the chat thread.');
    expect(prompt).toContain('your final action must be to publish the reply into the current thread yourself by using the Yoke reply-current command shown above.');
    expect(prompt).toContain('After you have published the reply, end with only the decision line AGENT_CHAT_DECISION: respond and no extra text.');
  });

  test('chat prompt templates render double-curly placeholders', () => {
    const prompt = buildBootstrapPrompt({
      agent: {
        agentId: 'agent_EXAMPLE_AGENT',
        label: 'Wingman 21',
        botNpub: 'npub1bot',
        workspaceOwnerNpub: 'npub1workspace',
        groupNpubs: ['npub1group'],
        workingDirectory: '/tmp/exampleAgent',
        capabilities: ['chat_intercept'],
        chatPromptTemplate: 'Chat {{agent_id}} {{thread_id}} {{recent_turns}}',
        taskPromptTemplate: '',
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        managedByNpub: 'npub1manager',
      },
      isNewSession: true,
      subscription: {
        subscriptionId: 'sub-1',
        workspaceOwnerNpub: 'npub1workspace',
        backendBaseUrl: 'https://tower.example.com',
        botNpub: 'npub1bot',
        sourceAppNpub: 'npub1source',
        wsKeyNpub: null,
        wsKeyStatus: 'active',
        groupKeyStatus: 'active',
        sseStatus: 'connected',
        healthStatus: 'healthy',
        triggerConfigRecordId: null,
        lastSseEventId: null,
        lastAuthOkAt: null,
        lastGroupRefreshAt: null,
        lastErrorCode: null,
        lastErrorAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        managedByNpub: 'npub1manager',
        wsKeyBlobJson: null,
        wrappedGroupKeysJson: null,
        lastAuthResult: null,
        lastGroupRefreshResult: null,
        lastRecordPullResult: null,
        lastDecryptResult: null,
        lastRoutingResult: null,
        lastSseEvent: null,
        recentSseEvents: [],
        recentDispatches: [],
        lastSuccessfulStartupReloadAt: null,
      },
      intercept: {
        routingKey: 'routing-key',
        subscriptionId: 'sub-1',
        agentId: 'agent_EXAMPLE_AGENT',
        sessionId: 'session-1',
        sessionClass: 'chat',
        workspaceOwnerNpub: 'npub1workspace',
        sourceAppNpub: 'npub1source',
        channelId: 'channel-1',
        threadId: 'thread-1',
        botNpub: 'npub1bot',
        lastMessageIdSeen: null,
        pendingMessageCount: 0,
        state: 'pending',
        lastDecision: 'pending',
        lastActivityAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      session: {
        id: 'session-1',
        agent: 'codex',
        port: 0,
        name: 'Agent Chat',
        status: 'running',
        startedAt: new Date().toISOString(),
        command: [],
        workingDirectory: '/tmp/exampleAgent',
        logs: [],
      },
      yokeStateDir: '/tmp/state',
      context: null,
      contextError: null,
      latestTurn: {
        messageId: 'msg-1',
        senderNpub: 'npub1human',
        sentAt: new Date().toISOString(),
        content: 'Hello',
      },
    });

    expect(prompt).toContain('Chat agent_EXAMPLE_AGENT thread-1 1. npub1human: Hello');
  });

  test('chat completion goal includes the latest message and stop syntax', () => {
    const goal = buildChatCompletionGoal({
      messageId: 'msg-1',
      senderNpub: 'npub1human',
      sentAt: new Date().toISOString(),
      content: 'Can you run the Perth Central handymen flow for me?',
    });

    expect(goal).toContain('Have you answered the chat message thoroughly?');
    expect(goal).toContain('bun clis/sessions.ts metadata-update --next-action stop');
    expect(goal).toContain('The message was: Can you run the Perth Central handymen flow for me?');
  });
});

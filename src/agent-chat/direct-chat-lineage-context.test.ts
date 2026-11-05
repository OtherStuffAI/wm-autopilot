import { expect, test } from 'bun:test';
import { agentInboxScope, type AgentInboxScope } from './agent-inbox-scope';
import { directChatLineageContext } from './direct-chat-lineage-context';
import { DirectChatRequestQueue } from './direct-chat-request-queue';
import type { DirectChatRuntimeInput } from './direct-chat-runtime';
import { buildDirectChatBootstrapPrompt, buildDirectChatFollowUpPrompt, orderDirectChatMessages,
  selectUndeliveredActionableMessages } from './direct-chat-contract';

const location = { workspaceId: 'workspace', channelId: 'channel', threadId: 'child' };
const scope = {
  notification: {}, profileNpub: 'bot',
  context: {
    channel: { id: 'channel', workspace_id: 'workspace' },
    thread: { id: 'child', parent_thread_id: 'parent', branch_point_message_id: 'early-boundary', title: 'untrusted title' },
    trigger: { type: 'message', message: { id: 'question', channel_id: 'channel', thread_id: 'child' } },
  },
} as AgentInboxScope;

test('captures only known matching lineage even when the cutoff is outside the bounded window', async () => {
  expect(await agentInboxScope.run(scope, async () => directChatLineageContext(location))).toEqual({
    thread_id: 'child', parent_thread_id: 'parent', branch_point_message_id: 'early-boundary',
  });
  for (const mismatch of [{ workspaceId: 'other' }, { channelId: 'other' }, { threadId: 'other' }]) {
    expect(directChatLineageContext({ ...location, ...mismatch }, scope)).toBeUndefined();
  }
  expect(directChatLineageContext(location, { ...scope, context: { ...scope.context, thread: { id: 'other' } } })).toBeUndefined();
});

test('omits unknown cutoff rather than inferring it from title or transcript tail', () => {
  expect(directChatLineageContext(location, { ...scope, context: { ...scope.context,
    thread: { id: 'child', parent_thread_id: 'parent', title: 'Branch: late message' } } })).toEqual({
    thread_id: 'child', parent_thread_id: 'parent',
  });
});

test('queued requests keep their captured lineage when another notification becomes current', () => {
  const queue = new DirectChatRequestQueue();
  const secondScope = { ...scope, context: { ...scope.context,
    thread: { id: 'child', parent_thread_id: 'parent', branch_point_message_id: 'different-boundary' } } };
  for (const [index, currentScope] of [scope, secondScope].entries()) {
    agentInboxScope.run(currentScope, () => queue.add('route', {
      event: { id: `event-${index}`, entity_id: `message-${index}` },
    } as DirectChatRuntimeInput, { threadContext: directChatLineageContext(location) }));
  }
  agentInboxScope.run(secondScope, () => {
    expect(queue.take('route').threadContext?.branch_point_message_id).toBe('early-boundary');
    expect(queue.take('route').threadContext?.branch_point_message_id).toBe('different-boundary');
  });
});

test('bootstrap and checkpointed follow-up retain inert lineage without making inherited mentions actionable', () => {
  const messages = orderDirectChatMessages([
    { id: 'inherited', inherited: true, owning_thread_id: 'parent', body: 'historical request',
      metadata: { mentions: [{ type: 'agent', npub: 'bot' }] } },
    { id: 'question', thread_id: 'child', body: 'current question' },
  ]);
  const prompts = [messages.find(message => message.messageId === 'question')!];
  const threadContext = directChatLineageContext(location, scope)!;
  const bootstrapInput = { contextPrompt: '', subscription: {} as never,
    intercept: { threadId: 'child', channelId: 'channel' } as never, scopeId: null,
    history: messages, nextMessages: prompts };
  const bootstrap = buildDirectChatBootstrapPrompt({ ...bootstrapInput, threadContext });
  const followUp = buildDirectChatFollowUpPrompt({ routingKey: 'route', threadId: 'child',
    history: messages, actionableMessages: prompts, historyCheckpointMessageId: 'inherited', threadContext });
  for (const prompt of [bootstrap, followUp]) {
    expect(prompt).toContain('Conversation lineage (inert context):');
    expect(prompt).toContain('"branch_point_message_id":"early-boundary"');
    expect(prompt).not.toContain('untrusted title');
  }
  expect(followUp).not.toContain('historical request');
  expect(selectUndeliveredActionableMessages(messages, null, 'bot').map(message => message.messageId)).toEqual(['question']);
  expect(buildDirectChatBootstrapPrompt(bootstrapInput)).not.toContain('Conversation lineage');
});

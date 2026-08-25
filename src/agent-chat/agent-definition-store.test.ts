import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test } from 'bun:test';

import { AgentDefinitionStore } from './agent-definition-store';
import {
  DEFAULT_APPROVAL_DISPATCH_PROMPT_TEMPLATE,
  DEFAULT_CHAT_DISPATCH_PROMPT_TEMPLATE,
  DEFAULT_FLOW_DISPATCH_PROMPT_TEMPLATE,
  DEFAULT_TASK_DISPATCH_PROMPT_TEMPLATE,
  DEFAULT_TASK_REVIEW_PROMPT_TEMPLATE,
} from './prompt-templates';

function makeTempDb(): string {
  return join(tmpdir(), `agent-chat-agent-store-${randomUUID()}.sqlite`);
}

describe('AgentDefinitionStore', () => {
  test('persists one explicit default profile per manager', () => {
    const store = new AgentDefinitionStore(makeTempDb());
    const first = '2026-01-01T00:00:00.000Z';
    const second = '2026-01-02T00:00:00.000Z';
    const create = (agentId: string, botNpub: string, createdAt: string) => store.save({
      agentId,
      label: agentId,
      botNpub,
      workspaceOwnerNpub: 'npub1workspace',
      groupNpubs: [],
      workingDirectory: `/tmp/${agentId}`,
      capabilities: ['chat_intercept'],
      enabled: true,
      createdAt,
      updatedAt: createdAt,
      managedByNpub: 'npub1manager',
    });

    create('rick', 'npub1rick', first);
    create('brick', 'npub1brick', second);
    expect(store.getDefaultForManagerNpub('npub1manager')?.agentId).toBe('rick');

    store.setDefaultForManagerNpub('npub1manager', 'brick');
    expect(store.getDefaultForManagerNpub('npub1manager')?.agentId).toBe('brick');
    expect(() => store.setDefaultForManagerNpub('npub1other', 'rick')).toThrow('Agent profile not found');
  });

  test('persists and filters local agent definitions', () => {
    const store = new AgentDefinitionStore(makeTempDb());
    const now = new Date().toISOString();

    store.save({
      agentId: 'agent_alpha',
      label: 'Alpha',
      botNpub: 'npub1botalpha',
      workspaceOwnerNpub: 'npub1workspace',
      groupNpubs: ['npub1groupb', 'npub1groupa', 'npub1groupa'],
      workingDirectory: '/tmp/alpha',
      directChat: { enabled: true, sessionAgent: 'codex', directory: '/Users/example/wingmen/agent-workspace', model: null, idleRetentionMinutes: 60 },
      capabilities: ['chat_intercept'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: 'npub1manager',
    });
    store.save({
      agentId: 'agent_beta',
      label: 'Beta',
      botNpub: 'npub1botbeta',
      workspaceOwnerNpub: 'npub1workspace',
      groupNpubs: ['npub1groupc'],
      workingDirectory: '/tmp/beta',
      capabilities: ['chat_intercept'],
      enabled: false,
      createdAt: now,
      updatedAt: now,
      managedByNpub: 'npub1manager',
    });

    const managedAgents = store.listForManagerNpub('npub1manager');
    expect(managedAgents).toHaveLength(2);
    expect(managedAgents[0]?.agentId).toBe('agent_alpha');
    expect(managedAgents[0]?.groupNpubs).toEqual(['npub1groupa', 'npub1groupb']);
    expect(managedAgents[0]?.directChat).toEqual({ enabled: true, sessionAgent: 'codex', directory: '/Users/example/wingmen/agent-workspace', model: null, idleRetentionMinutes: 60 });

    const workspaceBotAgents = store.listByWorkspaceAndBot('npub1workspace', 'npub1botalpha');
    expect(workspaceBotAgents.map((agent) => agent.agentId)).toEqual(['agent_alpha', 'agent_beta']);
    expect(workspaceBotAgents[0]?.workingDirectory).toBe('/tmp/alpha');
    expect(managedAgents[1]?.directChat).toBeUndefined();
  });

  test('normalises capabilities backward-compatibly', () => {
    const store = new AgentDefinitionStore(makeTempDb());
    const now = new Date().toISOString();

    store.save({
      agentId: 'agent_task',
      label: 'Task Agent',
      botNpub: 'npub1bottask',
      workspaceOwnerNpub: 'npub1workspace',
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/task',
      capabilities: ['task_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: 'npub1manager',
    });
    store.save({
      agentId: 'agent_comment',
      label: 'Comment Agent',
      botNpub: 'npub1botcomment',
      workspaceOwnerNpub: 'npub1workspace',
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/comment',
      capabilities: ['comment_dispatch'],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: 'npub1manager',
    });
    store.save({
      agentId: 'agent_legacy',
      label: 'Legacy Agent',
      botNpub: 'npub1botlegacy',
      workspaceOwnerNpub: 'npub1workspace',
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/legacy',
      capabilities: ['unknown' as never],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: 'npub1manager',
    });

    expect(store.getByAgentId('agent_task')?.capabilities).toEqual(['task_dispatch']);
    expect(store.getByAgentId('agent_comment')?.capabilities).toEqual(['comment_dispatch']);
    expect(store.getByAgentId('agent_legacy')?.capabilities).toEqual(['chat_intercept']);
    expect(store.getByAgentId('agent_legacy')?.chatPromptTemplate).toBe(DEFAULT_CHAT_DISPATCH_PROMPT_TEMPLATE);
    expect(store.getByAgentId('agent_legacy')?.taskPromptTemplate).toBe(DEFAULT_TASK_DISPATCH_PROMPT_TEMPLATE);
    expect(store.getByAgentId('agent_legacy')?.flowDispatchPromptTemplate).toBe(DEFAULT_FLOW_DISPATCH_PROMPT_TEMPLATE);
    expect(store.getByAgentId('agent_legacy')?.taskReviewPromptTemplate).toBe(DEFAULT_TASK_REVIEW_PROMPT_TEMPLATE);
    expect(store.getByAgentId('agent_legacy')?.approvalDispatchPromptTemplate).toBe(DEFAULT_APPROVAL_DISPATCH_PROMPT_TEMPLATE);
  });

  test('persists custom dispatch prompt templates', () => {
    const store = new AgentDefinitionStore(makeTempDb());
    const now = new Date().toISOString();

    store.save({
      agentId: 'agent_prompted',
      label: 'Prompted',
      botNpub: 'npub1botprompted',
      workspaceOwnerNpub: 'npub1workspace',
      groupNpubs: ['npub1group'],
      workingDirectory: '/tmp/prompted',
      capabilities: ['chat_intercept', 'task_dispatch'],
      chatPromptTemplate: 'Chat {{agent_id}} {{thread_id}}',
      taskPromptTemplate: 'Task {{task_id}} {{scope_id}}',
      flowDispatchPromptTemplate: 'Flow {{task_id}}',
      taskReviewPromptTemplate: 'Review {{task_id}}',
      approvalDispatchPromptTemplate: 'Approval {{approval_id}}',
      enabled: true,
      createdAt: now,
      updatedAt: now,
      managedByNpub: 'npub1manager',
    });

    const stored = store.getByAgentId('agent_prompted');
    expect(stored?.chatPromptTemplate).toBe('Chat {{agent_id}} {{thread_id}}');
    expect(stored?.taskPromptTemplate).toBe('Task {{task_id}} {{scope_id}}');
    expect(stored?.flowDispatchPromptTemplate).toBe('Flow {{task_id}}');
    expect(stored?.taskReviewPromptTemplate).toBe('Review {{task_id}}');
    expect(stored?.approvalDispatchPromptTemplate).toBe('Approval {{approval_id}}');
  });
});

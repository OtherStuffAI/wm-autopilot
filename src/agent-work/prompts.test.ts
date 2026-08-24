import { describe, expect, test } from 'bun:test';

import {
  buildAgentWorkGoal,
  buildTaskDispatchPrompt,
} from './prompts';

function makeAgent() {
  return {
    agentId: 'agent_EXAMPLE_AGENT',
    label: 'Wingman 21',
    botNpub: 'npub1bot',
    workspaceOwnerNpub: 'npub1workspace',
    groupNpubs: ['npub1group'],
    workingDirectory: '/tmp/exampleAgent',
    capabilities: ['task_dispatch'],
    chatPromptTemplate: '',
    taskPromptTemplate: 'Task {{task_id}} in {{scope_id}} lineage {{scope_lineage}} :: {{title}}',
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    managedByNpub: 'npub1manager',
  };
}

describe('Agent work prompts', () => {
  test('renders task prompt templates with scope placeholders', () => {
    const prompt = buildTaskDispatchPrompt({
      agent: {
        ...makeAgent(),
      },
      dispatchReason: 'new task',
      task: {
        taskId: 'task-1',
        flowId: 'flow-1',
        flowRunId: 'run-1',
        flowStep: '2',
        scopeId: 'scope-7',
        scopeL1Id: 'l1-a',
        scopeL2Id: 'l2-b',
        scopeL3Id: null,
        scopeL4Id: null,
        scopeL5Id: null,
        title: 'Ship it',
        description: 'Complete the task',
        state: 'open',
        assignedTo: 'npub1bot',
        deleted: false,
        done: false,
        predecessorTaskIds: [],
      },
    });

    expect(prompt).toBe('Task task-1 in scope-7 lineage l1-a > l2-b :: Ship it');
  });

  test('builds a reflection goal for task completion and handoff', () => {
    const goal = buildAgentWorkGoal({
      taskId: 'task-1',
      flowId: 'flow-1',
      flowRunId: 'run-1',
      flowStep: '2',
      scopeId: 'scope-7',
      scopeL1Id: 'l1-a',
      scopeL2Id: 'l2-b',
      scopeL3Id: null,
      scopeL4Id: null,
      scopeL5Id: null,
      title: 'Ship it',
      description: 'Complete the task',
      state: 'open',
      assignedTo: 'npub1bot',
      deleted: false,
      done: false,
      predecessorTaskIds: [],
    });

    expect(goal).toContain('reflect and consider if you have adequately achieved the task');
    expect(goal).toContain('bun clis/sessions.ts metadata-update --next-action stop');
    expect(goal).toContain('The task was: Ship it (task_id=task-1, flow_id=flow-1, flow_run_id=run-1, flow_step=2).');
  });

});

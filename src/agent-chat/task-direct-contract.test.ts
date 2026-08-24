import { describe, expect, test } from 'bun:test';

import {
  buildTaskDirectRoutingKey,
  buildTaskDirectTurnId,
  isTaskDirectEvent,
  normaliseTaskDirectTrigger,
} from './task-direct-contract';

const exampleAgent = { type: 'agent', actor_id: 'actor-exampleAgent', npub: 'npub-exampleAgent', label: 'exampleAgent' };
const jane = { type: 'agent', actor_id: 'actor-jane', npub: 'npub-jane', label: 'wm22' };

describe('task direct contract', () => {
  test('anchors routing to Tower, workspace, agent, and task', () => {
    expect(buildTaskDirectRoutingKey({
      towerServiceNpub: 'tower', workspaceId: 'workspace', agentId: 'exampleAgent', taskId: 'task-1',
    })).toBe('task-direct:v1:tower:workspace:exampleAgent:task-1');
  });

  test('routes canonical Tower task create mentions', () => {
    const trigger = normaliseTaskDirectTrigger({
      event_id: 'create-1', event_type: 'flightdeck_pg.task.created', entity_type: 'task',
      entity_id: 'task-1', operation: 'created', entity_row_version: 1,
      payload: { task_id: 'task-1', task: { id: 'task-1' }, mentions: [exampleAgent] },
    });
    expect(trigger?.reasonsByAgentNpub.get('npub-exampleAgent')).toEqual(['description_mention_added']);
  });

  test('diffs canonical Tower task update mentions by actor id or npub', () => {
    const trigger = normaliseTaskDirectTrigger({
      event_id: 'update-1', event_type: 'flightdeck_pg.task.updated', entity_type: 'task',
      entity_id: 'task-1', operation: 'updated', entity_row_version: 2,
      payload: { task_id: 'task-1', task: { id: 'task-1' }, mentions: {
        previous: [exampleAgent, { type: 'agent', npub: 'npub-stable' }],
        current: [{ ...exampleAgent, npub: 'npub-exampleAgent-rotated' }, { type: 'agent', npub: 'npub-stable' }, jane],
      } },
    });
    expect(trigger?.reasonsByAgentNpub.has('npub-exampleAgent-rotated')).toBe(false);
    expect(trigger?.reasonsByAgentNpub.get('npub-jane')).toEqual(['description_mention_added']);
  });

  test('does not route unchanged Tower task update mentions', () => {
    expect(normaliseTaskDirectTrigger({
      event_id: 'update-unchanged', event_type: 'flightdeck_pg.task.updated', entity_type: 'task',
      entity_id: 'task-1', operation: 'updated', payload: { task_id: 'task-1', mentions: { previous: [exampleAgent], current: [exampleAgent] } },
    })).toBeNull();
  });

  test('routes only absent-to-present Tower assignments', () => {
    const assigned = {
      event_id: 'assignment-1', event_type: 'flightdeck_pg.task_assignment.assigned',
      entity_type: 'task_assignment', entity_id: 'task-1', operation: 'assigned',
      payload: { task_id: 'task-1', assignee: { actor_id: 'actor-exampleAgent', actor_npub: 'npub-exampleAgent' },
        transition: { previous: 'absent', current: 'present' }, assignment: { task_id: 'task-1', actor_id: 'actor-exampleAgent' } },
    };
    expect(normaliseTaskDirectTrigger(assigned)?.reasonsByAgentNpub.get('npub-exampleAgent')).toEqual(['agent_assigned']);
    expect(isTaskDirectEvent(assigned)).toBe(true);
    expect(normaliseTaskDirectTrigger({ ...assigned, event_id: 'assignment-delete',
      event_type: 'flightdeck_pg.task_assignment.unassigned', operation: 'unassigned',
      payload: { ...assigned.payload, transition: { previous: 'present', current: 'absent' } } })).toBeNull();
  });

  test('routes canonical Tower task comment mentions', () => {
    expect(normaliseTaskDirectTrigger({
      event_id: 'comment-1', event_type: 'flightdeck_pg.task_comment.created', entity_type: 'task_comment',
      entity_id: 'comment-1', operation: 'created', payload: { task_id: 'task-1', mentions: [exampleAgent],
        comment: { id: 'comment-1', task_id: 'task-1', metadata: { mentions: [exampleAgent] } } },
    })?.reasonsByAgentNpub.get('npub-exampleAgent')).toEqual(['comment_mention_added']);
  });

  test('keeps legacy synthetic transition fields compatible', () => {
    const trigger = normaliseTaskDirectTrigger({ event_id: 'legacy-1', entity_type: 'task', entity_id: 'task-1', payload: {
      newly_added_mentions: [{ type: 'agent', npub: 'npub-exampleAgent' }],
      newly_assigned_agents: [{ agent_npub: 'npub-exampleAgent' }],
    } });
    expect(trigger?.reasonsByAgentNpub.get('npub-exampleAgent')).toEqual(['description_mention_added', 'agent_assigned']);
  });

  test('creates deterministic turn identities for publisher idempotency', () => {
    expect(buildTaskDirectTurnId('route', ['a', 'b'])).toBe(buildTaskDirectTurnId('route', ['a', 'b']));
    expect(buildTaskDirectTurnId('route', ['a', 'b'])).not.toBe(buildTaskDirectTurnId('route', ['b', 'a']));
  });
});

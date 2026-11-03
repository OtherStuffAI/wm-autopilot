import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { AgentInboxEnvelope } from './agent-inbox-client';
import { AgentInboxProcessor } from './agent-inbox-runtime';
import { AgentInboxStore } from './agent-inbox-store';
import type { WorkspaceSubscriptionRecord } from './types';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const record = { subscriptionId: 'sub-1', botNpub: 'npub1bot' } as WorkspaceSubscriptionRecord;
const request = { backendBaseUrl: 'https://tower.example', workspaceId: 'ws-1', appNpub: 'npub1app', botIdentity: { botNpub: 'npub1bot' } } as any;
const envelope: AgentInboxEnvelope = { id: 'n-task', seq: 1, state: 'active', kind: 'task_assigned', occurred_at: '2026-11-03T01:00:00.000Z',
  source: { type: 'task', id: 'task-1', version: 3, channel_id: 'channel-1', thread_id: null, task_id: 'task-1', doc_id: null } };
// The reduced task shape Tower's agent-notification context returns today (no metadata, no flow linkage).
const reducedTask = { id: 'task-1', workspace_id: 'ws-1', channel_id: 'channel-1', scope_id: 'scope-1', title: 'Do it', description: null,
  state: 'new', priority: 'sand', assigned_to_npub: 'npub1bot', row_version: 3 };

function run(task: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-flow-'));
  dirs.push(dir);
  const store = new AgentInboxStore(join(dir, 'db.sqlite'));
  store.setMode('sub-1', 'inbox_required', 'c');
  store.update('sub-1', { towerSubscriptionId: 'tower-sub', cursor: 'tower-sub~c0', floorAt: '2026-11-02T00:00:00.000Z' });
  const dispatched: string[] = [];
  const acks: Array<[string, string | null]> = [];
  const processor = new AgentInboxProcessor({
    store, record: () => {}, dispatch: async (_r, event) => { dispatched.push(String(event.event_type)); },
    client: {
      createSubscription: async () => { throw new Error('unused'); },
      list: async () => ({ subscription_id: 'tower-sub', notifications: [envelope], next_cursor: 'tower-sub~c1', has_more: false }),
      context: async () => ({ channel: { id: 'channel-1', workspace_id: 'ws-1' }, trigger: { type: 'task', task } }) as any,
      ack: async (_ctx, _id, input) => { acks.push([input.outcome, input.code ?? null]); return { outcome: input.outcome, replayed: false, acked_through_seq: 1 }; },
    },
  });
  return { processor, dispatched, acks };
}

describe('strict inbox and agent flow steps', () => {
  test('the real reduced task shape dispatches as an ordinary task trigger (no flow linkage exists)', async () => {
    const r = run(reducedTask);
    await r.processor.pollOnce(record, request);
    expect(r.dispatched).toEqual(['flightdeck_pg.task_assignment.assigned']);
    expect(r.acks).toEqual([['handled', null]]);
  });

  test('a flow-linked task is never run as an ordinary task: blocked with an explicit compatibility code', async () => {
    for (const task of [
      { ...reducedTask, flow_id: 'flow-1' },
      { ...reducedTask, flow_run_id: 'run-1', flow_step: 'review' },
      { ...reducedTask, metadata: { flowRunId: 'run-1' } },
    ]) {
      const r = run(task);
      await r.processor.pollOnce(record, request);
      expect(r.dispatched).toEqual([]);
      expect(r.acks).toEqual([['failed_permanent', 'agent_inbox_flow_unsupported']]);
    }
  });
});

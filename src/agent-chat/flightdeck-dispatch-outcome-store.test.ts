import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';

import { FlightDeckDispatchOutcomeStore } from './flightdeck-dispatch-outcome-store';
import { isSessionWaitTimeout } from './flightdeck-dispatch-lifecycle';

const files: string[] = [];

function makeStore() {
  const file = join(tmpdir(), `flightdeck-dispatch-outcomes-${crypto.randomUUID()}.sqlite`);
  files.push(file);
  return new FlightDeckDispatchOutcomeStore(file);
}

afterEach(() => {
  for (const file of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      const target = `${file}${suffix}`;
      if (existsSync(target)) rmSync(target);
    }
  }
});

describe('FlightDeckDispatchOutcomeStore', () => {
  test('recognises both final-response and provisional native-discovery wait timeouts', () => {
    expect(isSessionWaitTimeout(new Error('Timed out waiting for session session-1 to produce a final response.'))).toBe(true);
    expect(isSessionWaitTimeout(new Error('Timed out waiting for accepted Direct Chat session session-1: native Codex session was not captured; terminal output was rejected.'))).toBe(true);
    expect(isSessionWaitTimeout(new Error('Session creation failed.'))).toBe(false);
  });

  test('upgrades a queued chat outcome only after a real session exists', () => {
    const store = makeStore();
    store.recordHistory('sub-1', {
      at: '2026-07-28T01:00:00.000Z',
      kind: 'chat',
      action: 'chat_dispatch',
      agentId: 'exampleAgent',
      sessionId: null,
      recordId: 'message-1',
    });

    expect(store.listPage(['sub-1'], { limit: 25, offset: 0 }).rows).toEqual([]);

    store.recordSessionQueued({
      subscriptionId: 'sub-1',
      recordId: 'message-1',
      agentId: 'exampleAgent',
      receivedAt: '2026-07-28T01:00:00.000Z',
      details: { routing_key: 'route-1', agent_npub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3nq5gg' },
    });
    expect(store.listPage(['sub-1'], { limit: 25, offset: 0 }).rows[0]).toMatchObject({
      receivedAt: '2026-07-28T01:00:00.000Z',
      outcome: 'queued',
      action: null,
      actionId: null,
      agentId: 'exampleAgent',
      dispatchAction: 'chat_dispatch_queued',
      status: 'queued',
      reasonCode: 'session_creation_pending',
      reasonLabel: 'Waiting for durable session',
    });

    store.recordSession({
      subscriptionId: 'sub-1',
      recordId: 'message-1',
      agentId: 'exampleAgent',
      sessionId: 'session-1',
      receivedAt: '2026-07-28T01:00:00.000Z',
    });

    expect(store.listPage(['sub-1'], { limit: 25, offset: 0 }).rows[0]).toMatchObject({
      receivedAt: '2026-07-28T01:00:00.000Z',
      trigger: 'chat',
      outcome: 'launched',
      action: 'session',
      actionId: 'session-1',
    });

    store.recordSessionFailure({
      subscriptionId: 'sub-1',
      recordId: 'message-1',
      agentId: 'exampleAgent',
      receivedAt: '2026-07-28T01:00:01.000Z',
      error: 'Agent response was invalid.',
    });
    expect(store.listPage(['sub-1'], { limit: 25, offset: 0 }).rows[0]).toMatchObject({
      outcome: 'failed',
      action: 'session',
      actionId: 'session-1',
    });
  });

  test('does not present a deduplicated pipeline run as a newly launched action', () => {
    const store = makeStore();
    store.recordHistory('sub-1', {
      at: '2026-07-28T02:00:00.000Z',
      kind: 'chat',
      action: 'chat_pipeline_suppressed',
      agentId: 'dispatch-pipeline',
      sessionId: null,
      pipelineRunId: 'existing-run',
      recordId: 'message-2',
      status: 'suppressed',
      suppressionReason: 'dedupe_window',
    });

    expect(store.listPage(['sub-1'], {
      limit: 25,
      offset: 0,
      includeIgnoredAndSuppressed: true,
    }).rows[0]).toMatchObject({
      outcome: 'suppressed',
      action: null,
      actionId: null,
      reasonCode: 'recent_duplicate',
      reasonLabel: 'Recent duplicate',
      sourceLabel: 'Source label not recorded',
    });
  });

  test('excludes ignored and suppressed outcomes unless explicitly included', () => {
    const store = makeStore();
    store.recordHistory('sub-1', {
      at: '2026-07-28T02:00:00.000Z', kind: 'chat', action: 'chat_pipeline_suppressed',
      agentId: 'dispatch-pipeline', recordId: 'message-1', status: 'suppressed',
    });
    store.recordSession({
      subscriptionId: 'sub-1', recordId: 'message-2', agentId: 'exampleAgent', sessionId: 'session-1',
    });

    expect(store.listPage(['sub-1'], {
      limit: 25, offset: 0, includeIgnoredAndSuppressed: false,
    })).toMatchObject({ total: 1 });
    expect(store.listPage(['sub-1'], {
      limit: 25, offset: 0, includeIgnoredAndSuppressed: true,
    })).toMatchObject({ total: 2 });
  });

  test('keeps wait timeouts provisional and recovers only with authoritative later evidence', () => {
    const store = makeStore();
    const shared = {
      subscriptionId: 'sub-1', recordId: 'message-timeout', agentId: 'exampleAgent', sessionId: 'session-1',
      receivedAt: '2026-07-28T02:00:00.000Z', details: { routing_key: 'route-1', channel_id: 'channel-1' },
    };
    store.recordSession(shared);
    store.recordSessionWaitTimeout({
      ...shared,
      details: { routing_key: 'route-1' },
      error: 'Timed out waiting for session session-1 to produce a final response.',
    });
    expect(store.listPage(['sub-1'], { limit: 25, offset: 0 }).rows[0]).toMatchObject({
      outcome: 'launched', action: 'session', actionId: 'session-1', status: 'waiting',
      reasonCode: 'provisional_timeout', reasonLabel: 'Session wait timed out; completion pending',
      details: { error: 'Timed out waiting for session session-1 to produce a final response.', channel_id: 'channel-1' },
    });

    const recovered = store.recordSessionRecovered({ ...shared, evidence: 'flightdeck_delivery', publishedMessageId: 'reply-1' });
    expect(recovered).toMatchObject({
      outcome: 'launched', action: 'session', actionId: 'session-1', status: 'recovered',
      reasonCode: 'recovered_success', reasonLabel: 'Recovered after provisional timeout',
      details: { recovery: { evidence: 'flightdeck_delivery', published_message_id: 'reply-1' } },
    });
    expect(store.recordSessionRecovered({ ...shared, evidence: 'final_turn' })).toBeNull();
  });

  test('does not upgrade a genuine failure without timeout evidence', () => {
    const store = makeStore();
    store.recordSession({
      subscriptionId: 'sub-1', recordId: 'message-failed', agentId: 'exampleAgent', sessionId: 'session-2',
    });
    store.recordSessionFailure({
      subscriptionId: 'sub-1', recordId: 'message-failed', agentId: 'exampleAgent',
      error: 'client_request_id was already used for a materially different message',
    });
    expect(store.recordSessionRecovered({
      subscriptionId: 'sub-1', recordId: 'message-failed', agentId: 'exampleAgent', sessionId: 'session-2', evidence: 'final_turn',
    })).toBeNull();
    expect(store.listPage(['sub-1'], { limit: 25, offset: 0 }).rows[0]).toMatchObject({
      outcome: 'failed', action: 'session', actionId: 'session-2',
      reasonCode: 'dispatch_failed', reasonLabel: 'Genuine dispatch failure',
    });
  });

  test('records stable reasons and authoritative source labels for chat, task, and document triggers', () => {
    const store = makeStore();
    store.recordHistory('sub-1', {
      at: '2026-07-28T02:00:00.000Z', kind: 'chat', action: 'chat_pipeline_suppressed',
      agentId: 'pipeline', sessionId: null, recordId: 'message-1', status: 'suppressed',
      suppressionReason: 'self_authored', sourceLabel: 'Useful thread title',
    });
    store.recordHistory('sub-1', {
      at: '2026-07-28T02:01:00.000Z', kind: 'task', action: 'task_pipeline_dispatch',
      agentId: 'pipeline', sessionId: null, pipelineRunId: 'run-task', recordId: 'task-1',
      status: 'running', sourceLabel: 'Ship dispatch labels',
    });
    store.recordHistory('sub-1', {
      at: '2026-07-28T02:02:00.000Z', kind: 'document', action: 'document_pipeline_dispatch',
      agentId: 'pipeline', sessionId: null, pipelineRunId: 'run-doc', recordId: 'doc-1',
      status: 'running', sourceLabel: 'Dispatch design',
    });

    expect(store.listPage(['sub-1'], { limit: 25, offset: 0 }).rows.map((row) => ({
      trigger: row.trigger, sourceLabel: row.sourceLabel, reasonCode: row.reasonCode,
    }))).toEqual([
      { trigger: 'doc', sourceLabel: 'Dispatch design', reasonCode: null },
      { trigger: 'task', sourceLabel: 'Ship dispatch labels', reasonCode: null },
      { trigger: 'chat', sourceLabel: 'Useful thread title', reasonCode: 'self_authored' },
    ]);

    store.recordHistory('sub-1', {
      at: '2026-07-28T02:03:00.000Z', kind: 'chat', action: 'chat_skip_unauthorized_actor',
      agentId: 'security', sessionId: null, recordId: 'message-unauthorized',
      sourceLabel: 'Unauthorized request', details: { suppression_reason: 'unauthorized_dispatch_actor' },
    });
    expect(store.listPage(['sub-1'], { limit: 1, offset: 0 }).rows[0]).toMatchObject({
      outcome: 'suppressed', reasonCode: 'unauthorized_actor', reasonLabel: 'Actor is not authorized',
    });
  });

  test('migrates legacy tables and maps missing historical metadata honestly', () => {
    const file = join(tmpdir(), `flightdeck-dispatch-outcomes-legacy-${crypto.randomUUID()}.sqlite`);
    files.push(file);
    const db = new Database(file);
    db.exec(`CREATE TABLE flightdeck_dispatch_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, outcome_key TEXT NOT NULL UNIQUE,
      subscription_id TEXT NOT NULL, received_at TEXT NOT NULL, trigger TEXT NOT NULL,
      outcome TEXT NOT NULL, action TEXT, action_id TEXT, record_id TEXT NOT NULL,
      agent_id TEXT NOT NULL, dispatch_action TEXT NOT NULL, status TEXT,
      details_json TEXT, updated_at TEXT NOT NULL
    )`);
    db.query(`INSERT INTO flightdeck_dispatch_outcomes (
      outcome_key, subscription_id, received_at, trigger, outcome, action, action_id,
      record_id, agent_id, dispatch_action, status, details_json, updated_at
    ) VALUES (?1, ?2, ?3, 'chat', 'suppressed', NULL, NULL, ?4, 'pipeline',
      'chat_pipeline_suppressed', 'suppressed', NULL, ?3)`)
      .run('legacy-1', 'sub-1', '2026-07-28T02:00:00.000Z', 'message-legacy');
    db.query(`INSERT INTO flightdeck_dispatch_outcomes (
      outcome_key, subscription_id, received_at, trigger, outcome, action, action_id,
      record_id, agent_id, dispatch_action, status, details_json, updated_at
    ) VALUES (?1, ?2, ?3, 'chat', 'suppressed', NULL, NULL, ?4, 'pipeline',
      'chat_pipeline_suppressed', 'suppressed', ?5, ?3)`)
      .run('legacy-2', 'sub-1', '2026-07-28T02:01:00.000Z', 'message-legacy-details', JSON.stringify({
        suppression_reason: 'dedupe_in_flight',
      }));
    db.query(`INSERT INTO flightdeck_dispatch_outcomes (
      outcome_key, subscription_id, received_at, trigger, outcome, action, action_id,
      record_id, agent_id, dispatch_action, status, details_json, updated_at
    ) VALUES (?1, ?2, ?3, 'chat', 'launched', NULL, NULL, ?4, 'exampleAgent',
      'chat_dispatch_queued', 'queued', NULL, ?3)`)
      .run('legacy-queued', 'sub-1', '2026-07-28T02:02:00.000Z', 'message-legacy-queued');
    db.close();

    const store = new FlightDeckDispatchOutcomeStore(file);
    const rows = store.listPage(['sub-1'], { limit: 25, offset: 0 }).rows;
    expect(rows[0]).toMatchObject({
      outcome: 'queued',
      action: null,
      actionId: null,
      reasonCode: 'session_creation_pending',
      reasonLabel: 'Waiting for durable session',
    });
    expect(rows[1]).toMatchObject({
      reasonCode: 'in_flight_duplicate',
      reasonLabel: 'Already in flight',
      sourceLabel: 'Source label not recorded',
    });
    expect(rows[2]).toMatchObject({
      reasonCode: 'not_recorded',
      reasonLabel: 'Reason not recorded',
      sourceLabel: 'Source label not recorded',
    });
    const migrated = new Database(file);
    const columns = migrated.query('PRAGMA table_info(flightdeck_dispatch_outcomes)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(['reason_code', 'reason_label', 'source_label']));
    migrated.close();
  });

  test('maps document comments to doc triggers and paginates in SQLite', () => {
    const store = makeStore();
    for (let index = 0; index < 31; index += 1) {
      store.recordHistory('sub-1', {
        at: new Date(Date.UTC(2026, 6, 28, 3, 0, index)).toISOString(),
        kind: 'comment',
        action: 'comment_pipeline_dispatch',
        agentId: 'dispatch-pipeline',
        sessionId: null,
        pipelineRunId: `run-${index}`,
        recordId: `comment-${index}`,
        bindingId: 'doc-1',
        bindingType: 'document',
        status: 'running',
      });
    }

    const first = store.listPage(['sub-1'], { limit: 25, offset: 0 });
    const second = store.listPage(['sub-1'], { limit: 25, offset: 25 });
    expect(first.total).toBe(31);
    expect(first.rows).toHaveLength(25);
    expect(first.rows[0]).toMatchObject({ trigger: 'doc', action: 'pipeline', actionId: 'run-30' });
    expect(second.rows).toHaveLength(6);
    expect(second.rows.at(-1)?.actionId).toBe('run-0');
  });
});

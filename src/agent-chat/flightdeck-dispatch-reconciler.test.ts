import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Database } from 'bun:sqlite';

import {
  dispatchSourceKey,
  reconcileHistoricalFlightDeckDispatchOutcomes,
} from './flightdeck-dispatch-reconciler';

const files: string[] = [];

afterEach(() => {
  for (const file of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      const target = `${file}${suffix}`;
      if (existsSync(target)) rmSync(target);
    }
  }
});

describe('historical Flight Deck dispatch reconciliation', () => {
  test('dry-runs all cohorts without mutation and preserves launch-then-duplicate links', async () => {
    const file = makeDatabase();
    const report = await reconcileHistoricalFlightDeckDispatchOutcomes({
      databasePath: file,
      dryRun: true,
      loadSourceLabels: async () => ({
        labels: new Map([[dispatchSourceKey('sub-1', 'self-message'), 'Authoritative chat thread']]),
        requests: 3,
      }),
    });

    expect(report).toMatchObject({
      dryRun: true,
      backupPath: null,
      scannedRows: 6,
      changedRows: 6,
      reasonChanges: 5,
      sourceChanges: 6,
      sourceLabelsRecovered: 1,
      sourceFallbackRows: 5,
      preservedLaunchThenDuplicateRows: 1,
      sourceLookupRequests: 3,
      before: { total: 6, reasonRecorded: 0, sourceRecorded: 0, byReason: {} },
      after: {
        total: 6,
        reasonRecorded: 5,
        sourceRecorded: 6,
        byReason: {
          dispatch_failed: 1,
          recent_duplicate: 2,
          self_authored: 1,
          unauthorized_actor: 1,
        },
      },
    });
    const db = new Database(file);
    expect(db.query('SELECT COUNT(*) AS count FROM flightdeck_dispatch_outcomes WHERE reason_code IS NOT NULL').get()).toEqual({ count: 0 });
    db.close();
  });

  test('backs up before mutation and repeated runs are idempotent', async () => {
    const file = makeDatabase();
    const now = () => new Date('2026-07-28T12:34:56.789Z');
    const loadSourceLabels = async () => ({ labels: new Map<string, string>() });
    const applied = await reconcileHistoricalFlightDeckDispatchOutcomes({
      databasePath: file,
      dryRun: false,
      loadSourceLabels,
      now,
    });
    expect(applied.changedRows).toBe(6);
    expect(applied.backupPath).not.toBeNull();
    files.push(applied.backupPath!);
    expect(existsSync(applied.backupPath!)).toBe(true);

    const backup = new Database(applied.backupPath!, { readonly: true });
    expect(backup.query('SELECT COUNT(*) AS count FROM flightdeck_dispatch_outcomes WHERE reason_code IS NOT NULL').get()).toEqual({ count: 0 });
    backup.close();

    const db = new Database(file, { readonly: true });
    expect(db.query("SELECT outcome, action, action_id, reason_code FROM flightdeck_dispatch_outcomes WHERE record_id = 'launched-duplicate'").get()).toEqual({
      outcome: 'launched',
      action: 'pipeline',
      action_id: 'run-original',
      reason_code: 'recent_duplicate',
    });
    db.close();

    const repeated = await reconcileHistoricalFlightDeckDispatchOutcomes({
      databasePath: file,
      dryRun: false,
      loadSourceLabels,
      now,
    });
    expect(repeated).toMatchObject({ changedRows: 0, unchangedRows: 6, backupPath: null });
  });

  test('repairs only timeout rows with exact authoritative turn evidence', async () => {
    const file = makeLifecycleDatabase();
    const dryRun = await reconcileHistoricalFlightDeckDispatchOutcomes({ databasePath: file, dryRun: true });
    expect(dryRun.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        recordId: 'late-final', actionId: 'session-1', fromOutcome: 'failed', toOutcome: 'launched',
        toReason: 'recovered_success', evidence: 'final_turn:turn-1',
      }),
      expect.objectContaining({
        recordId: 'still-waiting', actionId: 'session-2', fromOutcome: 'failed', toOutcome: 'launched',
        toReason: 'provisional_timeout', evidence: null,
      }),
      expect.objectContaining({
        recordId: 'request-conflict', actionId: null, fromOutcome: 'failed', toOutcome: 'failed',
        toReason: 'dispatch_failed', evidence: null,
      }),
    ]));

    const applied = await reconcileHistoricalFlightDeckDispatchOutcomes({ databasePath: file, dryRun: false });
    files.push(applied.backupPath!);
    const db = new Database(file, { readonly: true });
    expect(db.query("SELECT outcome, action, action_id, status, reason_code FROM flightdeck_dispatch_outcomes WHERE record_id = 'late-final'").get()).toEqual({
      outcome: 'launched', action: 'session', action_id: 'session-1', status: 'recovered', reason_code: 'recovered_success',
    });
    expect(db.query("SELECT outcome, action, action_id, status, reason_code FROM flightdeck_dispatch_outcomes WHERE record_id = 'still-waiting'").get()).toEqual({
      outcome: 'launched', action: 'session', action_id: 'session-2', status: 'waiting', reason_code: 'provisional_timeout',
    });
    expect(db.query("SELECT outcome, action, action_id, status, reason_code FROM flightdeck_dispatch_outcomes WHERE record_id = 'request-conflict'").get()).toEqual({
      outcome: 'failed', action: null, action_id: null, status: 'failed', reason_code: 'dispatch_failed',
    });
    db.close();
    const repeated = await reconcileHistoricalFlightDeckDispatchOutcomes({ databasePath: file, dryRun: true });
    expect(repeated.changedRows).toBe(0);
  });
});

function makeLifecycleDatabase(): string {
  const file = join(tmpdir(), `flightdeck-dispatch-lifecycle-${crypto.randomUUID()}.sqlite`);
  files.push(file);
  const db = new Database(file);
  db.exec(`CREATE TABLE flightdeck_dispatch_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, outcome_key TEXT NOT NULL UNIQUE,
    subscription_id TEXT NOT NULL, received_at TEXT NOT NULL, trigger TEXT NOT NULL,
    outcome TEXT NOT NULL, action TEXT, action_id TEXT, record_id TEXT NOT NULL,
    agent_id TEXT NOT NULL, dispatch_action TEXT NOT NULL, status TEXT,
    reason_code TEXT, reason_label TEXT, source_label TEXT, details_json TEXT, updated_at TEXT NOT NULL
  ); CREATE TABLE agent_direct_chat_turns (
    turn_id TEXT PRIMARY KEY, routing_key TEXT NOT NULL, source_message_ids_json TEXT NOT NULL,
    state TEXT NOT NULL
  )`);
  const timeout = (sessionId: string) => `Timed out waiting for session ${sessionId} to produce a final response.`;
  insert(db, 'late-final', 'failed', 'session', 'session-1', 'chat_session_failed', 'failed', {
    routing_key: 'route-1', error: timeout('session-1'),
  });
  insert(db, 'still-waiting', 'failed', 'session', 'session-2', 'chat_session_failed', 'failed', {
    routing_key: 'route-2', error: timeout('session-2'),
  });
  insert(db, 'request-conflict', 'failed', null, null, 'chat_session_failed', 'failed', {
    routing_key: 'route-3', error: 'client_request_id was already used for a materially different message',
  });
  db.query(`INSERT INTO agent_direct_chat_turns (turn_id, routing_key, source_message_ids_json, state)
    VALUES ('turn-1', 'route-1', '["late-final"]', 'completed'),
      ('turn-not-authoritative', 'wrong-route', '["request-conflict"]', 'completed')`).run();
  db.close();
  return file;
}

function makeDatabase(): string {
  const file = join(tmpdir(), `flightdeck-dispatch-reconcile-${crypto.randomUUID()}.sqlite`);
  files.push(file);
  const db = new Database(file);
  db.exec(`CREATE TABLE flightdeck_dispatch_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    outcome_key TEXT NOT NULL UNIQUE,
    subscription_id TEXT NOT NULL,
    received_at TEXT NOT NULL,
    trigger TEXT NOT NULL,
    outcome TEXT NOT NULL,
    action TEXT,
    action_id TEXT,
    record_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    dispatch_action TEXT NOT NULL,
    status TEXT,
    reason_code TEXT,
    reason_label TEXT,
    source_label TEXT,
    details_json TEXT,
    updated_at TEXT NOT NULL
  )`);
  insert(db, 'self-message', 'suppressed', null, null, 'chat_pipeline_suppressed', 'suppressed', {
    suppression_reason: 'self_authored',
  });
  insert(db, 'duplicate-message', 'suppressed', null, null, 'chat_pipeline_suppressed', 'suppressed', {
    diagnostic_summary: 'Dispatch route already handled this advisory within 300s: run-old',
  });
  insert(db, 'unauthorized-message', 'ignored', null, null, 'chat_skip_unauthorized_actor', null, {
    suppression_reason: 'unauthorized_dispatch_actor',
  });
  insert(db, 'failed-message', 'failed', null, null, 'chat_session_failed', 'failed', {
    error: 'client_request_id conflict',
  });
  insert(db, 'clean-launch', 'launched', 'pipeline', 'run-clean', 'chat_pipeline_dispatch', 'running', {});
  insert(db, 'launched-duplicate', 'launched', 'pipeline', 'run-original', 'chat_pipeline_suppressed', 'suppressed', {
    diagnostic_summary: 'Dispatch route already handled this advisory within 300s: run-original',
  });
  db.close();
  return file;
}

function insert(
  db: Database,
  recordId: string,
  outcome: string,
  action: string | null,
  actionId: string | null,
  dispatchAction: string,
  status: string | null,
  details: Record<string, unknown>,
): void {
  db.query(`INSERT INTO flightdeck_dispatch_outcomes (
    outcome_key, subscription_id, received_at, trigger, outcome, action, action_id,
    record_id, agent_id, dispatch_action, status, reason_code, reason_label, source_label,
    details_json, updated_at
  ) VALUES (?1, 'sub-1', '2026-07-28T00:00:00.000Z', 'chat', ?2, ?3, ?4,
    ?1, 'exampleAgent', ?5, ?6, NULL, NULL, NULL, ?7, '2026-07-28T00:00:00.000Z')`)
    .run(recordId, outcome, action, actionId, dispatchAction, status, JSON.stringify(details));
}

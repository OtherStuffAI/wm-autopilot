import { mkdirSync } from 'node:fs';
import { dirname, extname, join, basename } from 'node:path';

import { Database } from 'bun:sqlite';

import {
  FLIGHT_DECK_GENUINE_FAILURE_LABEL,
  FLIGHT_DECK_PROVISIONAL_TIMEOUT_LABEL,
  FLIGHT_DECK_RECOVERED_SUCCESS_LABEL,
  FLIGHT_DECK_SOURCE_LABEL_NOT_RECORDED,
  resolveFlightDeckDispatchReason,
} from './flightdeck-dispatch-metadata';
import { isSessionWaitTimeout } from './flightdeck-dispatch-lifecycle';
import type { AgentChatDispatchHistoryEntry } from './types';

export interface HistoricalDispatchRow {
  id: number;
  subscriptionId: string;
  receivedAt: string;
  trigger: 'chat' | 'task' | 'doc';
  outcome: 'launched' | 'suppressed' | 'ignored' | 'failed';
  action: 'pipeline' | 'session' | null;
  actionId: string | null;
  recordId: string;
  agentId: string;
  dispatchAction: string;
  status: string | null;
  reasonCode: string | null;
  reasonLabel: string | null;
  sourceLabel: string | null;
  details: Record<string, unknown>;
  updatedAt: string;
}

export interface DispatchSourceLabels {
  labels: Map<string, string>;
  warnings?: string[];
  requests?: number;
}

export interface DispatchReconciliationReport {
  dryRun: boolean;
  databasePath: string;
  backupPath: string | null;
  scannedRows: number;
  changedRows: number;
  reasonChanges: number;
  sourceChanges: number;
  sourceLabelsRecovered: number;
  sourceFallbackRows: number;
  unchangedRows: number;
  preservedLaunchThenDuplicateRows: number;
  sourceLookupRequests: number;
  sourceLookupWarnings: string[];
  changes: DispatchReconciliationChange[];
  before: DispatchReconciliationEvidence;
  after: DispatchReconciliationEvidence;
}

export interface DispatchReconciliationChange {
  rowId: number;
  recordId: string;
  action: 'pipeline' | 'session' | null;
  actionId: string | null;
  fromOutcome: string;
  toOutcome: string;
  fromReason: string | null;
  toReason: string | null;
  evidence: string | null;
}

export interface DispatchReconciliationEvidence {
  total: number;
  reasonRecorded: number;
  sourceRecorded: number;
  byOutcome: Record<string, number>;
  byReason: Record<string, number>;
}

interface PlannedRow {
  row: HistoricalDispatchRow;
  outcome: HistoricalDispatchRow['outcome'];
  status: string | null;
  dispatchAction: string;
  reasonCode: string | null;
  reasonLabel: string | null;
  sourceLabel: string;
  details: Record<string, unknown>;
  recoveryEvidence: string | null;
  terminalChanged: boolean;
  detailsChanged: boolean;
  reasonChanged: boolean;
  sourceChanged: boolean;
}

export function dispatchSourceKey(subscriptionId: string, recordId: string): string {
  return `${subscriptionId}:${recordId}`;
}

export async function reconcileHistoricalFlightDeckDispatchOutcomes(input: {
  databasePath: string;
  dryRun: boolean;
  loadSourceLabels?: (rows: HistoricalDispatchRow[]) => Promise<DispatchSourceLabels>;
  now?: () => Date;
}): Promise<DispatchReconciliationReport> {
  const db = new Database(input.databasePath);
  db.exec('PRAGMA busy_timeout = 5000');
  try {
    const rows = readHistoricalRows(db);
    const recoveryEvidence = readAuthoritativeRecoveryEvidence(db, rows);
    const sourceResult = input.loadSourceLabels
      ? await input.loadSourceLabels(rows)
      : { labels: new Map<string, string>() };
    const planned = rows.map((row) => planRow(row, sourceResult.labels, recoveryEvidence));
    const changed = planned.filter((entry) => (
      entry.reasonChanged || entry.sourceChanged || entry.terminalChanged || entry.detailsChanged
    ));
    const before = evidence(rows.map((row) => ({
      outcome: row.outcome,
      reasonCode: row.reasonCode,
      sourceLabel: row.sourceLabel,
    })));
    const after = evidence(planned.map((entry) => ({
      outcome: entry.outcome,
      reasonCode: entry.reasonCode,
      sourceLabel: entry.sourceLabel,
    })));
    let backupPath: string | null = null;

    if (!input.dryRun && changed.length > 0) {
      backupPath = createSqliteBackup(db, input.databasePath, (input.now ?? (() => new Date()))());
      const updatedAt = (input.now ?? (() => new Date()))().toISOString();
      const update = db.query(`UPDATE flightdeck_dispatch_outcomes
        SET outcome = ?1, dispatch_action = ?2, status = ?3, reason_code = ?4, reason_label = ?5,
          source_label = ?6, details_json = ?7, updated_at = ?8
        WHERE id = ?9`);
      db.transaction(() => {
        for (const entry of changed) {
          update.run(entry.outcome, entry.dispatchAction, entry.status, entry.reasonCode, entry.reasonLabel,
            entry.sourceLabel, JSON.stringify(entry.details), updatedAt, entry.row.id);
        }
      })();
    }

    return {
      dryRun: input.dryRun,
      databasePath: input.databasePath,
      backupPath,
      scannedRows: rows.length,
      changedRows: changed.length,
      reasonChanges: changed.filter((entry) => entry.reasonChanged).length,
      sourceChanges: changed.filter((entry) => entry.sourceChanged).length,
      sourceLabelsRecovered: planned.filter((entry) => (
        sourceResult.labels.has(dispatchSourceKey(entry.row.subscriptionId, entry.row.recordId))
        && entry.sourceLabel !== FLIGHT_DECK_SOURCE_LABEL_NOT_RECORDED
      )).length,
      sourceFallbackRows: planned.filter((entry) => entry.sourceLabel === FLIGHT_DECK_SOURCE_LABEL_NOT_RECORDED).length,
      unchangedRows: rows.length - changed.length,
      preservedLaunchThenDuplicateRows: planned.filter((entry) => (
        entry.row.outcome === 'launched'
        && entry.row.action !== null
        && entry.row.actionId !== null
        && entry.reasonCode === 'recent_duplicate'
      )).length,
      sourceLookupRequests: sourceResult.requests ?? 0,
      sourceLookupWarnings: sourceResult.warnings ?? [],
      changes: changed.map((entry) => ({
        rowId: entry.row.id,
        recordId: entry.row.recordId,
        action: entry.row.action,
        actionId: entry.row.actionId,
        fromOutcome: entry.row.outcome,
        toOutcome: entry.outcome,
        fromReason: entry.row.reasonCode,
        toReason: entry.reasonCode,
        evidence: entry.recoveryEvidence,
      })),
      before,
      after,
    };
  } finally {
    db.close();
  }
}

function planRow(
  row: HistoricalDispatchRow,
  labels: Map<string, string>,
  recoveryEvidence: Map<string, string>,
): PlannedRow {
  const history = historyEntryForRow(row);
  let reason = resolveFlightDeckDispatchReason(history);
  let outcome = row.outcome;
  let status = row.status;
  let dispatchAction = row.dispatchAction;
  let details = row.details;
  const evidence = recoveryEvidence.get(dispatchSourceKey(row.subscriptionId, row.recordId)) ?? null;
  if (row.action === 'session' && row.actionId && historicalTimeoutError(row)) {
    details = withTimeoutHistory(row);
    if (evidence) {
      outcome = 'launched';
      status = 'recovered';
      dispatchAction = 'chat_session_recovered';
      reason = { code: 'recovered_success', label: FLIGHT_DECK_RECOVERED_SUCCESS_LABEL };
      details = { ...details, recovery: { evidence, session_id: row.actionId } };
    } else {
      outcome = 'launched';
      status = 'waiting';
      dispatchAction = 'chat_session_wait_timeout';
      reason = { code: 'provisional_timeout', label: FLIGHT_DECK_PROVISIONAL_TIMEOUT_LABEL };
    }
  } else if (row.outcome === 'failed') {
    reason = row.reasonCode
      ? { code: row.reasonCode, label: row.reasonLabel ?? FLIGHT_DECK_GENUINE_FAILURE_LABEL }
      : { code: 'dispatch_failed', label: FLIGHT_DECK_GENUINE_FAILURE_LABEL };
  }
  const sourceLabel = labels.get(dispatchSourceKey(row.subscriptionId, row.recordId))?.trim()
    || row.sourceLabel?.trim()
    || FLIGHT_DECK_SOURCE_LABEL_NOT_RECORDED;
  return {
    row,
    outcome,
    status,
    dispatchAction,
    reasonCode: reason.code,
    reasonLabel: reason.label,
    sourceLabel,
    details,
    recoveryEvidence: evidence,
    terminalChanged: row.outcome !== outcome || row.status !== status || row.dispatchAction !== dispatchAction,
    detailsChanged: JSON.stringify(row.details) !== JSON.stringify(details),
    reasonChanged: row.reasonCode !== reason.code || row.reasonLabel !== reason.label,
    sourceChanged: row.sourceLabel !== sourceLabel,
  };
}

function historyEntryForRow(row: HistoricalDispatchRow): AgentChatDispatchHistoryEntry {
  return {
    at: row.receivedAt,
    kind: row.trigger === 'doc' ? 'document' : row.trigger,
    action: row.dispatchAction,
    agentId: row.agentId,
    sessionId: row.action === 'session' ? row.actionId : null,
    pipelineRunId: row.action === 'pipeline' ? row.actionId : null,
    recordId: row.recordId,
    status: row.status ?? row.outcome,
    suppressionReason: text(row.details.suppression_reason),
    dedupeReason: text(row.details.dedupe_reason),
    details: row.details,
  };
}

function readHistoricalRows(db: Database): HistoricalDispatchRow[] {
  const rows = db.query('SELECT * FROM flightdeck_dispatch_outcomes ORDER BY id').all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: Number(row.id),
    subscriptionId: String(row.subscription_id),
    receivedAt: String(row.received_at),
    trigger: String(row.trigger) as HistoricalDispatchRow['trigger'],
    outcome: String(row.outcome) as HistoricalDispatchRow['outcome'],
    action: row.action ? String(row.action) as HistoricalDispatchRow['action'] : null,
    actionId: text(row.action_id),
    recordId: String(row.record_id),
    agentId: String(row.agent_id),
    dispatchAction: String(row.dispatch_action),
    status: text(row.status),
    reasonCode: text(row.reason_code),
    reasonLabel: text(row.reason_label),
    sourceLabel: text(row.source_label),
    details: jsonObject(row.details_json),
    updatedAt: String(row.updated_at),
  }));
}

function readAuthoritativeRecoveryEvidence(
  db: Database,
  rows: HistoricalDispatchRow[],
): Map<string, string> {
  const evidence = new Map<string, string>();
  const byRecord = new Map<string, HistoricalDispatchRow[]>();
  for (const row of rows) {
    const matches = byRecord.get(row.recordId) ?? [];
    matches.push(row);
    byRecord.set(row.recordId, matches);
  }
  if (tableExists(db, 'flightdeck_session_turn_publications')) {
    const publications = db.query(`SELECT turn_id, session_id, source_message_ids_json, published_message_id, state
      FROM flightdeck_session_turn_publications WHERE state = 'completed' AND published_message_id IS NOT NULL`).all() as Array<Record<string, unknown>>;
    for (const publication of publications) {
      for (const recordId of jsonStrings(publication.source_message_ids_json)) {
        for (const row of byRecord.get(recordId) ?? []) {
          if (row.action !== 'session' || row.actionId !== text(publication.session_id)) continue;
          evidence.set(dispatchSourceKey(row.subscriptionId, row.recordId),
            `flightdeck_delivery:${text(publication.published_message_id)}`);
        }
      }
    }
  }
  if (tableExists(db, 'agent_direct_chat_turns')) {
    const turns = db.query(`SELECT turn_id, routing_key, source_message_ids_json, state
      FROM agent_direct_chat_turns WHERE state = 'completed'`).all() as Array<Record<string, unknown>>;
    for (const turn of turns) {
      for (const recordId of jsonStrings(turn.source_message_ids_json)) {
        for (const row of byRecord.get(recordId) ?? []) {
          if (row.action !== 'session' || !row.actionId) continue;
          if (text(row.details.routing_key) !== text(turn.routing_key)) continue;
          const key = dispatchSourceKey(row.subscriptionId, row.recordId);
          if (!evidence.has(key)) evidence.set(key, `final_turn:${text(turn.turn_id)}`);
        }
      }
    }
  }
  return evidence;
}

function tableExists(db: Database, name: string): boolean {
  return Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1").get(name));
}

function jsonStrings(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function historicalTimeoutError(row: HistoricalDispatchRow): string | null {
  const error = text(row.details.error);
  return error && isSessionWaitTimeout(error) ? error : null;
}

function withTimeoutHistory(row: HistoricalDispatchRow): Record<string, unknown> {
  const error = historicalTimeoutError(row)!;
  const diagnostics = Array.isArray(row.details.diagnostic_history) ? [...row.details.diagnostic_history] : [];
  if (!diagnostics.some((entry) => (
    entry && typeof entry === 'object' && !Array.isArray(entry)
    && (entry as Record<string, unknown>).code === 'session_wait_timeout'
  ))) {
    diagnostics.push({ code: 'session_wait_timeout', message: error, recorded_at: row.updatedAt });
  }
  return { ...row.details, diagnostic_history: diagnostics };
}

function evidence(rows: Array<{ outcome: string; reasonCode: string | null; sourceLabel: string | null }>): DispatchReconciliationEvidence {
  const byOutcome: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  let reasonRecorded = 0;
  let sourceRecorded = 0;
  for (const row of rows) {
    byOutcome[row.outcome] = (byOutcome[row.outcome] ?? 0) + 1;
    if (row.reasonCode) {
      reasonRecorded += 1;
      byReason[row.reasonCode] = (byReason[row.reasonCode] ?? 0) + 1;
    }
    if (row.sourceLabel?.trim()) sourceRecorded += 1;
  }
  return {
    total: rows.length,
    reasonRecorded,
    sourceRecorded,
    byOutcome: sortedRecord(byOutcome),
    byReason: sortedRecord(byReason),
  };
}

function createSqliteBackup(db: Database, databasePath: string, now: Date): string {
  const extension = extname(databasePath) || '.sqlite';
  const stem = basename(databasePath, extname(databasePath));
  const stamp = now.toISOString().replaceAll(/[-:.]/gu, '').replace('Z', 'Z');
  const backupPath = join(dirname(databasePath), `${stem}.backup-${stamp}${extension}`);
  mkdirSync(dirname(backupPath), { recursive: true });
  db.query('VACUUM INTO ?1').run(backupPath);
  return backupPath;
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sortedRecord(value: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

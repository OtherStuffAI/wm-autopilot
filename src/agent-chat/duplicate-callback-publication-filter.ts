import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import { databaseFile } from '../storage/message-store';

export interface DuplicateCallbackPublicationFilterConfig {
  marker: string;
  windowSeconds: number;
}

export interface DuplicateCallbackPublicationRoute {
  subscriptionId: string;
  agentNpub: string;
}

export type DuplicateCallbackPublicationConfigResolver = (
  route: DuplicateCallbackPublicationRoute,
) => DuplicateCallbackPublicationFilterConfig | null;

export type DuplicateCallbackPublicationOutcome = 'published' | 'suppressed';

export interface DuplicateCallbackPublicationDecision {
  decisionId: string;
  routingKey: string;
  outcome: DuplicateCallbackPublicationOutcome;
  reason: 'published' | 'duplicate_callback_within_window';
  marker: string | null;
  candidateAt: string;
  previousPublishedAt: string | null;
  publishedAt: string | null;
  publishedMessageId: string | null;
  createdAt: string;
}

export interface DuplicateCallbackFilterEvaluation {
  suppress: boolean;
  reason: 'policy_missing' | 'disabled' | 'marker_not_at_start' | 'timing_evidence_missing' | 'outside_window'
    | 'duplicate_callback_within_window';
  previousPublishedAt: string | null;
  elapsedSeconds: number | null;
}

export class DuplicateCallbackPublicationDecisionStore {
  private readonly db: Database;

  constructor(filePath = databaseFile) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS flightdeck_direct_chat_publication_decisions (
      decision_id TEXT PRIMARY KEY,
      routing_key TEXT NOT NULL,
      outcome TEXT NOT NULL,
      reason TEXT NOT NULL,
      marker TEXT,
      candidate_at TEXT NOT NULL,
      previous_published_at TEXT,
      published_at TEXT,
      published_message_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fd_direct_publication_route
      ON flightdeck_direct_chat_publication_decisions(routing_key, published_at DESC)
      WHERE outcome = 'published' AND published_at IS NOT NULL;`);
  }

  get(decisionId: string): DuplicateCallbackPublicationDecision | null {
    const row = this.db.query(`SELECT * FROM flightdeck_direct_chat_publication_decisions
      WHERE decision_id = ?1`).get(decisionId);
    return row ? this.map(row as Record<string, unknown>) : null;
  }

  getPreviousPublished(routingKey: string): DuplicateCallbackPublicationDecision | null {
    const row = this.db.query(`SELECT * FROM flightdeck_direct_chat_publication_decisions
      WHERE routing_key = ?1 AND outcome = 'published' AND published_at IS NOT NULL
      ORDER BY published_at DESC LIMIT 1`).get(routingKey);
    return row ? this.map(row as Record<string, unknown>) : null;
  }

  recordSuppressed(input: { decisionId: string; routingKey: string; marker: string; candidateAt: string;
    previousPublishedAt: string; createdAt?: string }): DuplicateCallbackPublicationDecision {
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.db.query(`INSERT INTO flightdeck_direct_chat_publication_decisions
      (decision_id,routing_key,outcome,reason,marker,candidate_at,previous_published_at,published_at,published_message_id,created_at)
      VALUES (?1,?2,'suppressed','duplicate_callback_within_window',?3,?4,?5,NULL,NULL,?6)
      ON CONFLICT(decision_id) DO NOTHING`)
      .run(input.decisionId, input.routingKey, input.marker, input.candidateAt, input.previousPublishedAt, createdAt);
    return this.get(input.decisionId)!;
  }

  recordPublished(input: { decisionId: string; routingKey: string; candidateAt: string; publishedAt: string;
    publishedMessageId: string; createdAt?: string }): DuplicateCallbackPublicationDecision {
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.db.query(`INSERT INTO flightdeck_direct_chat_publication_decisions
      (decision_id,routing_key,outcome,reason,marker,candidate_at,previous_published_at,published_at,published_message_id,created_at)
      VALUES (?1,?2,'published','published',NULL,?3,NULL,?4,?5,?6)
      ON CONFLICT(decision_id) DO UPDATE SET
        outcome='published',reason='published',marker=NULL,published_at=excluded.published_at,
        published_message_id=excluded.published_message_id`)
      .run(input.decisionId, input.routingKey, input.candidateAt, input.publishedAt, input.publishedMessageId, createdAt);
    return this.get(input.decisionId)!;
  }

  private map(row: Record<string, unknown>): DuplicateCallbackPublicationDecision {
    const optionalText = (key: string) => typeof row[key] === 'string' ? String(row[key]) : null;
    return {
      decisionId: String(row.decision_id),
      routingKey: String(row.routing_key),
      outcome: String(row.outcome) as DuplicateCallbackPublicationOutcome,
      reason: String(row.reason) as DuplicateCallbackPublicationDecision['reason'],
      marker: optionalText('marker'),
      candidateAt: String(row.candidate_at),
      previousPublishedAt: optionalText('previous_published_at'),
      publishedAt: optionalText('published_at'),
      publishedMessageId: optionalText('published_message_id'),
      createdAt: String(row.created_at),
    };
  }
}

function validTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function beginsWithMarker(body: string, marker: string): boolean {
  const firstNonHorizontalWhitespace = body.search(/[^\t ]/);
  if (firstNonHorizontalWhitespace < 0) return false;
  return body.slice(firstNonHorizontalWhitespace, firstNonHorizontalWhitespace + marker.length).toLocaleLowerCase('en-US')
    === marker.toLocaleLowerCase('en-US');
}

export class DuplicateCallbackPublicationFilter {
  constructor(
    private readonly resolveConfig: DuplicateCallbackPublicationConfigResolver,
    readonly store = new DuplicateCallbackPublicationDecisionStore(),
    private readonly log: Pick<Console, 'warn'> = console,
  ) {}

  evaluate(input: DuplicateCallbackPublicationRoute & {
    decisionId: string;
    routingKey: string;
    body: string;
    candidateAt: string;
  }): DuplicateCallbackFilterEvaluation {
    const existing = this.store.get(input.decisionId);
    if (existing?.outcome === 'suppressed') {
      const candidateMs = validTimestamp(existing.candidateAt);
      const previousMs = validTimestamp(existing.previousPublishedAt);
      return { suppress: true, reason: 'duplicate_callback_within_window',
        previousPublishedAt: existing.previousPublishedAt,
        elapsedSeconds: candidateMs !== null && previousMs !== null ? (candidateMs - previousMs) / 1_000 : null };
    }
    const config = this.resolveConfig(input);
    if (!config) {
      this.log.warn('[agent-chat] duplicate callback publication policy is missing', {
        decisionId: input.decisionId,
        routingKey: input.routingKey,
        subscriptionId: input.subscriptionId,
        agentNpub: input.agentNpub,
      });
      return { suppress: false, reason: 'policy_missing', previousPublishedAt: null, elapsedSeconds: null };
    }
    const marker = config.marker;
    if (!marker || !Number.isFinite(config.windowSeconds) || config.windowSeconds <= 0) {
      return { suppress: false, reason: 'disabled', previousPublishedAt: null, elapsedSeconds: null };
    }
    if (!beginsWithMarker(input.body, marker)) {
      return { suppress: false, reason: 'marker_not_at_start', previousPublishedAt: null, elapsedSeconds: null };
    }
    const candidateMs = validTimestamp(input.candidateAt);
    const previous = this.store.getPreviousPublished(input.routingKey);
    const previousMs = validTimestamp(previous?.publishedAt);
    if (candidateMs === null || previousMs === null) {
      return { suppress: false, reason: 'timing_evidence_missing', previousPublishedAt: previous?.publishedAt ?? null,
        elapsedSeconds: null };
    }
    const elapsedSeconds = (candidateMs - previousMs) / 1_000;
    if (elapsedSeconds < 0 || elapsedSeconds > config.windowSeconds) {
      return { suppress: false, reason: 'outside_window', previousPublishedAt: previous!.publishedAt, elapsedSeconds };
    }
    this.store.recordSuppressed({ decisionId: input.decisionId, routingKey: input.routingKey, marker,
      candidateAt: input.candidateAt, previousPublishedAt: previous!.publishedAt! });
    this.log.warn('[agent-chat] duplicate callback response suppressed', {
      decisionId: input.decisionId,
      routingKey: input.routingKey,
      marker,
      candidateAt: input.candidateAt,
      previousPublishedAt: previous!.publishedAt,
      elapsedSeconds,
      windowSeconds: config.windowSeconds,
    });
    return { suppress: true, reason: 'duplicate_callback_within_window',
      previousPublishedAt: previous!.publishedAt, elapsedSeconds };
  }

  recordPublished(input: { decisionId: string; routingKey: string; candidateAt: string; publishedAt: string;
    publishedMessageId: string }): DuplicateCallbackPublicationDecision {
    return this.store.recordPublished(input);
  }
}

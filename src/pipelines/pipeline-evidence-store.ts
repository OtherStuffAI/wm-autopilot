import type { Database } from "bun:sqlite";
import { redactPipelineValue } from "./pipeline-evidence-redaction";
import { evidenceDigest, PipelineEvidencePayloads } from "./pipeline-evidence-payloads";

import type { EvidencePreview } from "./pipeline-evidence-preview";
import { declaredEvidencePreview } from "./pipeline-declared-previews";
import { sanitizePreviewCapture } from "./pipeline-preview-metadata";
import { assertViewerEvidenceSafe, refineCapturedViewerPins } from "./pipeline-viewer-capture-redaction";

export type EvidenceKind = "resolved_input" | "executor_request" | "returned_output" | "state_write" | "side_effect_confirmation";
export type EvidenceAvailability = "complete" | "redacted" | "preview_only" | "not_captured" | "expired" | "oversized" | "unavailable";
export interface EvidenceReference {
  id: string; runId: string; stepId: string; attempt: number; kind: EvidenceKind;
  scope: string; contentType: string; bytes: number; availability: EvidenceAvailability;
  preview?: EvidencePreview | null; redacted: boolean; capturedAt: string | null; expiresAt: null;
}
export interface EvidenceCapture {
  runId: string; stepId: string; kind: EvidenceKind; scope: string; value: unknown;
  attempt?: number; secrets?: string[]; availability?: EvidenceAvailability;
}

const referenceColumns = "id, run_id, step_id, attempt, kind, scope, content_type, bytes, availability, redacted, captured_at, preview_json";

/** Append-only full values. No retention job or path-based access. */
export class PipelineEvidenceStore {
  private readonly executionSecrets = new Set<string>();

  registerSecret(secret: string): string {
    if (secret) this.executionSecrets.add(secret);
    return secret;
  }

  sanitize(value: unknown, secrets: string[] = []) {
    return redactPipelineValue(value, [...this.executionSecrets, ...secrets]);
  }

  readonly valueLimit: number;
  readonly runLimit: number;
  private readonly payloads: PipelineEvidencePayloads;
  constructor(private readonly db: Database, limits: { valueBytes?: number; runBytes?: number } = {}) {
    this.valueLimit = limits.valueBytes ?? positiveLimit(process.env.WINGMEN_PIPELINE_EVIDENCE_VALUE_BYTES, 16 * 1024 * 1024);
    this.runLimit = limits.runBytes ?? positiveLimit(process.env.WINGMEN_PIPELINE_EVIDENCE_RUN_BYTES, 128 * 1024 * 1024);
    db.run(`CREATE TABLE IF NOT EXISTS pipeline_evidence (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES pipeline_runs(id),
      step_id TEXT NOT NULL REFERENCES pipeline_steps(id), attempt INTEGER NOT NULL,
      kind TEXT NOT NULL, scope TEXT NOT NULL, content_type TEXT NOT NULL, bytes INTEGER NOT NULL,
      availability TEXT NOT NULL, redacted INTEGER NOT NULL, captured_at TEXT NOT NULL, content_hash TEXT, value_json TEXT
    )`);
    const columns = db.query("PRAGMA table_info(pipeline_evidence)").all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === "content_hash")) db.run("ALTER TABLE pipeline_evidence ADD COLUMN content_hash TEXT");
    if (!columns.some(column => column.name === "preview_json")) db.run("ALTER TABLE pipeline_evidence ADD COLUMN preview_json TEXT");
    if (!columns.some(column => column.name === "source_hash")) db.run("ALTER TABLE pipeline_evidence ADD COLUMN source_hash TEXT");
    this.payloads = new PipelineEvidencePayloads(db);
    if (!columns.some(column => column.name === "payload_id")) db.run("ALTER TABLE pipeline_evidence ADD COLUMN payload_id TEXT REFERENCES pipeline_evidence_payloads(id)");
    db.run(`CREATE INDEX IF NOT EXISTS idx_pipeline_evidence_run ON pipeline_evidence(run_id, step_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_pipeline_evidence_source ON pipeline_evidence(source_hash)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_pipeline_evidence_content ON pipeline_evidence(content_hash)`);
    db.run(`CREATE TRIGGER IF NOT EXISTS pipeline_evidence_immutable_update BEFORE UPDATE ON pipeline_evidence BEGIN SELECT RAISE(ABORT, 'Pipeline evidence is immutable'); END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS pipeline_evidence_immutable_delete BEFORE DELETE ON pipeline_evidence BEGIN SELECT RAISE(ABORT, 'Pipeline evidence retention forbids deletion'); END`);
  }

  capture(input: EvidenceCapture): EvidenceReference {
    return this.db.transaction(() => this.captureValue(input))();
  }

  assertViewerSafe(runId: string): void {
    assertViewerEvidenceSafe(this.db, runId);
  }

  private captureValue(input: EvidenceCapture): EvidenceReference {
    const root = this.payloads.root(input.runId, input.stepId);
    this.payloads.refuseMissingProvenance(input.runId, input.stepId, input.kind);
    const sourceHash = evidenceDigest(JSON.stringify(input.value ?? null));
    const retained = this.payloads.retainedSource(root, sourceHash);
    // Use raw boundary values to discover credentials echoed in selectors as well as content.
    const boundary = sanitizePreviewCapture(this.db, input.stepId, input.kind, input.value, retained,
      value => this.sanitize(value, input.secrets));
    const sanitized = retained ? this.sanitize(retained.value, input.secrets) : { value: boundary.value, redacted: boundary.redacted };
    sanitized.redacted ||= boundary.redacted;
    sanitized.redacted ||= retained?.redacted ?? false;
    if (sanitized.redacted) refineCapturedViewerPins(this.db, input.runId, root, input.value, value => this.sanitize(value, input.secrets));
    const json = JSON.stringify(sanitized.value ?? null);
    const bytes = Buffer.byteLength(json);
    const hash = evidenceDigest(json);
    const { used, repeated } = this.payloads.usedBytes(input.runId, hash);
    const oversized = bytes > this.valueLimit || used + (repeated ? 0 : bytes) > this.runLimit;
    const availability = oversized ? "oversized" : input.availability ?? (sanitized.redacted ? "redacted" : "complete");
    const retain = availability === "complete" || availability === "redacted" || availability === "preview_only";
    const ref: EvidenceReference = {
      id: crypto.randomUUID(), runId: input.runId, stepId: input.stepId, attempt: input.attempt ?? this.currentAttempt(input.stepId),
      kind: input.kind, scope: input.scope, contentType: typeof sanitized.value === "string" ? "text/plain" : "application/json",
      bytes, availability, preview: declaredEvidencePreview(sanitized.value, boundary.paths), redacted: sanitized.redacted, capturedAt: new Date().toISOString(), expiresAt: null,
    };
    const payloadId = retain ? this.payloads.intern(root, json, hash, bytes) : null;
    this.db.query(`INSERT INTO pipeline_evidence (id, run_id, step_id, attempt, kind, scope, content_type, bytes, availability, redacted, captured_at, content_hash, value_json, preview_json, source_hash, payload_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ref.id, ref.runId, ref.stepId, ref.attempt, ref.kind, ref.scope, ref.contentType, ref.bytes,
        ref.availability, Number(ref.redacted), ref.capturedAt, hash, null, JSON.stringify(ref.preview), sourceHash, payloadId);
    return ref;
  }

  ensureArchived(input: EvidenceCapture): EvidenceReference {
    const json = JSON.stringify(this.sanitize(input.value, input.secrets).value ?? null);
    const hash = evidenceDigest(json);
    const row = this.db.query(`SELECT ${referenceColumns} FROM pipeline_evidence WHERE run_id = ? AND step_id = ? AND kind = ? AND (content_hash = ? OR source_hash = ?) AND (availability IN ('complete', 'redacted', 'oversized', 'unavailable') OR (? = 'preview_only' AND availability = 'preview_only')) ORDER BY rowid DESC LIMIT 1`)
      .get(input.runId, input.stepId, input.kind, hash, evidenceDigest(JSON.stringify(input.value ?? null)), input.availability ?? "complete") as Record<string, unknown> | null;
    if (row) {
      this.readArchive(input.runId, String(row.id));
      return reference(row);
    }
    this.payloads.refuseMissingProvenance(input.runId, input.stepId, input.kind);
    return this.capture(input);
  }

  nextExecutorAttempt(stepId: string): number {
    return this.lastExecutorAttempt(stepId) + 1;
  }

  private lastExecutorAttempt(stepId: string): number {
    const row = this.db.query(`SELECT coalesce(max(attempt), 0) AS attempt FROM pipeline_evidence WHERE step_id = ? AND kind = 'executor_request'`).get(stepId) as { attempt: number };
    return row.attempt;
  }

  private currentAttempt(stepId: string): number {
    return Math.max(1, this.lastExecutorAttempt(stepId));
  }

  list(runId: string, stepId?: string): EvidenceReference[] {
    const rows = stepId
      ? this.db.query(`SELECT ${referenceColumns} FROM pipeline_evidence WHERE run_id = ? AND step_id = ? ORDER BY rowid`).all(runId, stepId)
      : this.db.query(`SELECT ${referenceColumns} FROM pipeline_evidence WHERE run_id = ? ORDER BY rowid`).all(runId);
    return rows.map(row => reference(row as Record<string, unknown>));
  }

  get(runId: string, id: string): { evidence: EvidenceReference; value: unknown } | null {
    this.assertViewerSafe(runId);
    return this.readArchive(runId, id);
  }

  private readArchive(runId: string, id: string): { evidence: EvidenceReference; value: unknown } | null {
    const row = this.db.query(`SELECT * FROM pipeline_evidence WHERE run_id = ? AND id = ?`).get(runId, id) as Record<string, unknown> | null;
    return row ? { evidence: reference(row), value: this.payloads.read(row) } : null;
  }
}

function reference(row: Record<string, unknown>): EvidenceReference {
  return { id: String(row.id), runId: String(row.run_id), stepId: String(row.step_id), attempt: Number(row.attempt),
    kind: row.kind as EvidenceKind, scope: String(row.scope), contentType: String(row.content_type), bytes: Number(row.bytes),
    availability: row.availability as EvidenceAvailability, preview: row.preview_json ? JSON.parse(String(row.preview_json)) : null, redacted: Boolean(row.redacted), capturedAt: String(row.captured_at), expiresAt: null };
}
function positiveLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid pipeline evidence byte limit");
  return limit;
}

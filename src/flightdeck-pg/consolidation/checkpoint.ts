import { signature, type RecordData, type ScanResult } from "./scan.ts";

export interface ReviewedFindings {
  scan_signature: string;
  incidents_complete: boolean;
  reconciliation_complete: boolean;
  groups: RecordData[];
  incident_evidence: RecordData[];
  unresolved_questions: RecordData;
  recommendation: unknown;
  blocker?: unknown;
}
/** Persist reviewed groups/links first. The checkpoint cannot advance on a task-only scan. */
export async function saveFindings(state: RecordData, scan: ScanResult, findings: ReviewedFindings,
  persist: (state: RecordData) => Promise<void>): Promise<RecordData> {
  if (findings.scan_signature !== signature(scan)) throw new Error("Review does not match current scan");
  if (!Array.isArray(findings.groups) || !Array.isArray(findings.incident_evidence)
    || !findings.unresolved_questions || typeof findings.incidents_complete !== "boolean"
    || typeof findings.reconciliation_complete !== "boolean") throw new Error("Missing reviewed findings");
  const scanTime = Date.parse(scan.started_at);
  const previous = state.last_successful_scan == null ? null : Date.parse(String(state.last_successful_scan));
  if (!Number.isFinite(scanTime) || (previous !== null && !Number.isFinite(previous))) throw new Error("Invalid checkpoint timestamp");
  const saved: RecordData = { ...state, groups: findings.groups, incident_evidence: findings.incident_evidence,
    unresolved_questions: findings.unresolved_questions, last_attempted_scan: scan.started_at,
    task_scan: scan, recommendation: findings.recommendation, blocker: findings.blocker ?? null };
  await persist(saved);
  if (scan.complete && findings.incidents_complete && findings.reconciliation_complete
    && (previous === null || scanTime > previous)) {
    saved.last_successful_scan = scan.started_at;
    await persist(saved);
  }
  return saved;
}
export interface DeliveryState {
  delivered_signature?: string;
  recommendation_signature?: string;
  blocker_signature?: string;
  blocker_delivered_at?: string;
  pending?: { signature: string; body: string; kind: "recommendation" | "blocker"; attempted: boolean };
}
export interface DeliveryTransport {
  readback(body: string): Promise<boolean>;
  send(body: string): Promise<void>;
}
/** Durable outbox: an ambiguous send is reconciled, never sent blindly a second time. */
export async function deliverDigest(state: DeliveryState, input: {
  kind: "recommendation" | "blocker"; material: unknown; body: string; now?: number; blockerIntervalMs?: number;
}, transport: DeliveryTransport, persist: (state: DeliveryState) => Promise<void>): Promise<"delivered" | "unchanged" | "throttled" | "uncertain"> {
  const hash = signature({ kind: input.kind, material: input.material });
  const now = input.now ?? Date.now();
  if (state.pending && state.pending.signature !== hash) throw new Error("Reconcile pending digest before replacing it");
  if (!state.pending && (state.delivered_signature === hash
    || (input.kind === "recommendation" && state.recommendation_signature === hash))) return "unchanged";
  if (!state.pending && input.kind === "blocker" && state.blocker_signature === hash
    && now - Date.parse(state.blocker_delivered_at ?? "") < (input.blockerIntervalMs ?? 24 * 60 * 60 * 1000)) return "throttled";
  const next = structuredClone(state);
  next.pending ??= { signature: hash, body: input.body, kind: input.kind, attempted: false };
  if (next.pending.body !== input.body) throw new Error("Pending digest body changed");
  await persist(next);
  if (!await transport.readback(input.body)) {
    if (next.pending.attempted) return "uncertain";
    next.pending.attempted = true;
    await persist(next);
    try { await transport.send(input.body); } catch { return "uncertain"; }
    if (!await transport.readback(input.body)) return "uncertain";
  }
  next.delivered_signature = hash;
  if (input.kind === "recommendation") next.recommendation_signature = hash;
  if (input.kind === "blocker") {
    next.blocker_signature = hash;
    next.blocker_delivered_at = new Date(now).toISOString();
  }
  delete next.pending;
  await persist(next);
  return "delivered";
}

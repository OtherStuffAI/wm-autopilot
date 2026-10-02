import type { Database } from "bun:sqlite";
import { evidenceDigest } from "./pipeline-evidence-payloads";

type Sanitize = (value: unknown) => { value: unknown; redacted: boolean };
type Metadata = Record<string, unknown>;
const markerKey = "previewCaptureMetadata";

/** Discover boundary credentials jointly, before selecting or persisting any display paths. */
export function preparePreviewMetadata(metadata: Metadata, value: unknown, sanitize: Sanitize) {
  const { [markerKey]: _marker, ...source } = metadata;
  const safe = sanitize({ metadata: source, value });
  const bundle = safe.value as { metadata: Metadata; value: unknown };
  const safeMetadata: Metadata = { ...bundle.metadata };
  if (hasPorts(safeMetadata)) safeMetadata[markerKey] = { displayHash: displayHash(safeMetadata), sourceHash: sourceHash(value), verified: false, redacted: safe.redacted };
  return { value: bundle.value, redacted: safe.redacted, metadata: safeMetadata };
}

/** A retired source cannot prove arbitrary new selectors safe; require the durable sanitized display. */
export function sanitizePreviewCapture(db: Database, stepId: string, kind: string, value: unknown, retained: { value: unknown; redacted: boolean } | null, sanitize: Sanitize) {
  const side = kind === "resolved_input" ? "in" : kind === "returned_output" ? "out" : null;
  if (!side) return { ...sanitize(value), paths: [] as string[] };
  const row = db.query("SELECT metadata_json FROM pipeline_steps WHERE id = ?").get(stepId) as { metadata_json: string | null };
  if (!row.metadata_json) return { ...sanitize(value), paths: [] as string[] };
  const metadata = JSON.parse(row.metadata_json) as Metadata;
  const display = metadata.display as Record<string, unknown> | undefined;
  const marker = metadata[markerKey] as { displayHash?: string; sourceHash?: string; verified?: boolean; redacted?: boolean } | undefined;
  const safe = preparePreviewMetadata(metadata, value, sanitize);
  const verifiedDisplay = marker?.verified === true && marker.displayHash === displayHash(metadata) && marker.sourceHash === sourceHash(value);
  const reproducedRedaction = safe.redacted && JSON.stringify(safe.value ?? null) === JSON.stringify(retained?.value ?? null);
  if (retained?.redacted && Array.isArray(display?.[side]) && display[side].length && !verifiedDisplay && !reproducedRedaction) {
    throw new Error("Redacted retained evidence lacks sanitized display provenance; refuse new port previews for operator review");
  }
  const safeMetadata = safe.metadata as Metadata;
  const safeDisplay = safeMetadata.display as Record<string, unknown> | undefined;
  const paths = Array.isArray(safeDisplay?.[side]) ? safeDisplay[side].map((field: { path?: unknown }) => field?.path)
    .filter((path: unknown): path is string => typeof path === "string") : [];
  const redacted = safe.redacted || marker?.redacted === true;
  if (hasPorts(safeMetadata)) safeMetadata[markerKey] = { displayHash: displayHash(safeMetadata), sourceHash: sourceHash(value), verified: true, redacted };
  const json = JSON.stringify(safeMetadata);
  if (json !== row.metadata_json) db.query("UPDATE pipeline_steps SET metadata_json = ? WHERE id = ?").run(json, stepId);
  return { value: safe.value, redacted, paths };
}

function displayHash(metadata: Metadata): string {
  return evidenceDigest(JSON.stringify(metadata.display ?? null));
}

function sourceHash(value: unknown): string {
  return evidenceDigest(JSON.stringify(value ?? null));
}

function hasPorts(metadata: Metadata): boolean {
  const display = metadata.display as Record<string, unknown> | undefined;
  return [display?.in, display?.out].some(fields => Array.isArray(fields) && fields.length > 0);
}

import { EVIDENCE_PREVIEW_BYTES, pipelineEvidencePreview, type EvidenceFieldPreview, type EvidencePreview } from "./pipeline-evidence-preview";

/** Same dot-path/object semantics as display selection; missing is distinct from JSON null. */
export function selectEvidenceField(value: unknown, path: string): { present: boolean; value: unknown } {
  if (path === "$") return { present: true, value };
  const parts = (path.startsWith("$.") ? path.slice(2) : path).split(".");
  let current = value;
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, part)) {
      return { present: false, value: null };
    }
    current = (current as Record<string, unknown>)[part];
  }
  return { present: true, value: current };
}

/** Values and declared paths must already share boundary redaction; fields take preview budget priority. */
export function declaredEvidencePreview(value: unknown, paths: string[]): EvidencePreview {
  const generic = pipelineEvidencePreview(value);
  if (!paths.length) return generic;
  const unique = [...new Set(paths)];
  const selected = unique.filter(path => path.length <= 256).slice(0, 16);
  const omitted = unique.length !== selected.length;
  for (const characters of [256, 128, 64, 16, 0]) {
    const fields: Record<string, EvidenceFieldPreview> = Object.create(null);
    for (const path of selected) {
      const field = selectEvidenceField(value, path);
      const preview = pipelineEvidencePreview(field.value, { characters });
      fields[path] = { present: field.present, value: preview.value, truncated: field.present && preview.truncated, count: preview.count };
    }
    const truncated = omitted || generic.truncated || Object.values(fields).some(field => field.truncated);
    const combined = { ...generic, truncated, fields };
    if (fits(combined)) return combined;
    const compact: EvidencePreview = { value: null, truncated: true, count: generic.count, fields };
    if (fits(compact)) return compact;
  }
  // Path overhead alone can exhaust the budget; excluded entries are explicitly outside the preview.
  const fields: Record<string, EvidenceFieldPreview> = Object.create(null);
  const preview: EvidencePreview = { value: null, truncated: true, count: generic.count, fields };
  for (const path of selected) {
    const field = selectEvidenceField(value, path);
    fields[path] = { present: field.present, value: null, truncated: field.present && field.value !== null, count: Array.isArray(field.value) ? field.value.length : null };
    if (!fits(preview)) { delete fields[path]; break; }
  }
  return preview;
}

function fits(preview: EvidencePreview): boolean {
  return Buffer.byteLength(JSON.stringify(preview)) <= EVIDENCE_PREVIEW_BYTES;
}

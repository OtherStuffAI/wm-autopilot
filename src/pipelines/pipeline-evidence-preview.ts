export interface EvidencePreview { value: unknown; truncated: boolean; count: number | null; counts?: Record<string, number> }
export const EVIDENCE_PREVIEW_BYTES = 2048;

/** Build only from already-redacted capture values; never fetch full values for a summary. */
export function pipelineEvidencePreview(value: unknown): EvidencePreview {
  const count = Array.isArray(value) ? value.length : null;
  for (const characters of [256, 64, 16]) {
    let truncated = false;
    let remaining = 600;
    const counts: Record<string, number> = {};
    function visit(item: unknown, depth: number, path = "$"): unknown {
      if (typeof item === "string") {
        const excerpt = item.slice(0, Math.min(characters, Math.max(0, remaining)));
        remaining -= excerpt.length;
        if (excerpt.length !== item.length) truncated = true;
        return excerpt;
      }
      if (item && typeof item === "object") {
        if (Array.isArray(item) && Object.keys(counts).length < 20) counts[path] = item.length;
        if (depth >= 4 || remaining <= 0) { truncated = true; return Array.isArray(item) ? { count: item.length } : { fields: Object.keys(item).length }; }
        if (Array.isArray(item)) {
          if (item.length > 2) truncated = true;
          return item.slice(0, 2).map((child, index) => visit(child, depth + 1, `${path}[${index}]`));
        }
        const entries = Object.entries(item);
        if (entries.length > 5) truncated = true;
        return Object.fromEntries(entries.slice(0, 5).map(([key, child]) => {
          const label = key.slice(0, 64);
          if (label !== key) truncated = true;
          return [label, visit(child, depth + 1, `${path}.${label}`)];
        }));
      }
      return item ?? null;
    }
    const preview = { value: visit(value, 0), truncated, count, counts };
    if (Buffer.byteLength(JSON.stringify(preview)) <= EVIDENCE_PREVIEW_BYTES) return preview;
  }
  return { value: null, truncated: true, count };
}

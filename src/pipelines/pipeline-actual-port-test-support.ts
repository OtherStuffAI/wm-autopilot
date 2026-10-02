import { expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { selectEvidenceField } from "./pipeline-declared-previews";
import { viewerSnapshot } from "./pipeline-viewer-dto";
import type { PipelineStore } from "./pipeline-store";

/** Assert actual runner archives against every declared port, independently of illustration fixtures. */
export function assertActualRuntimePorts(name: string, store: PipelineStore, runId: string) {
  const snapshot = viewerSnapshot(runId, store, "autopilot_runtime_fixture");
  const values: Record<string, unknown> = {};
  for (const step of snapshot.steps) for (const ref of step.evidence) {
    if (ref.capturedAt && ["complete", "redacted", "preview_only"].includes(ref.availability)) {
      values[ref.id] = store.evidence.get(runId, ref.id)!.value;
    }
  }
  for (const step of snapshot.steps) {
    if (step.status === "skipped") continue;
    for (const [ports, kind] of [[step.inputs, "resolved_input"], [step.outputs, "returned_output"]] as const) {
      const ref = step.evidence.findLast(ref => ref.kind === kind && ref.capturedAt);
      if (!ref) { expect(ports).toHaveLength(0); continue; }
      const full = store.evidence.get(runId, ref.id)!;
      expect(Buffer.byteLength(JSON.stringify(ref.preview))).toBeLessThanOrEqual(2048);
      for (const port of ports) {
        const actual = selectEvidenceField(full.value, port.path);
        expect(actual.present).toBe(true);
        const field = ref.preview?.fields?.[port.path];
        expect(field).toBeDefined();
        expect(field!.present).toBe(actual.present);
        expect(field!.count).toBe(Array.isArray(actual.value) ? actual.value.length : null);
        if (!field!.truncated) expect(field!.value).toEqual(actual.value);
        else assertSample(field!.value, actual.value);
      }
    }
  }
  if (process.env.PIPELINE_VIEWER_FIXTURE_DIR) {
    const directory = join(process.env.PIPELINE_VIEWER_FIXTURE_DIR, "evidence");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${name}.json`), JSON.stringify({ runId, values }, null, 2) + "\n");
  }
  return snapshot;
}

function assertSample(sample: unknown, full: unknown): void {
  if (typeof sample === "string") { expect(typeof full).toBe("string"); expect(String(full).startsWith(sample)).toBe(true); }
  else if (Array.isArray(sample)) {
    expect(Array.isArray(full)).toBe(true); expect(sample.length).toBeLessThanOrEqual(2);
    sample.forEach((item, index) => assertSample(item, (full as unknown[])[index]));
  } else if (sample && typeof sample === "object") {
    for (const [key, value] of Object.entries(sample)) assertSample(value, (full as Record<string, unknown>)[key]);
  } else expect(sample).toEqual(full);
}

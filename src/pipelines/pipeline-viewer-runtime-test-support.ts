import { expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { viewerSnapshot, type ViewerDefinitionStep } from "./pipeline-viewer-dto";
import type { PipelineStore } from "./pipeline-store";

/** Export real runner results on demand; normal repository tests need no sibling checkout. */
export async function assertRuntimeViewer(name: string, store: PipelineStore, runId: string) {
  const snapshot = { version: 1, serviceId: "autopilot_runtime_fixture", ...viewerSnapshot(runId, store, "autopilot_runtime_fixture") };
  const keys = new Set<string>();
  function visit(nodes: ViewerDefinitionStep[]) {
    for (const node of nodes) { keys.add(node.logicalKey); visit(node.children); }
  }
  visit(snapshot.definition.steps);
  if (snapshot.definition.availability !== "unavailable") for (const step of snapshot.steps) expect(keys.has(step.logicalKey)).toBe(true);
  for (const step of snapshot.steps) for (const ref of step.evidence) {
    expect(ref.stepId).toBe(step.id); expect(ref.runId).toBe(runId); expect(ref.attempt).toBeGreaterThan(0);
  }
  if (process.env.PIPELINE_VIEWER_PARSER) {
    const { snapshotDto } = await import(process.env.PIPELINE_VIEWER_PARSER);
    const parsed = snapshotDto(snapshot, snapshot.serviceId);
    expect(parsed.steps).toHaveLength(snapshot.steps.length);
    for (const step of snapshot.steps) for (const ref of step.evidence) if (ref.preview) {
      const accepted = parsed.steps.find((row: { id: string }) => row.id === step.id).evidence.find((row: { id: string }) => row.id === ref.id);
      expect(accepted.preview.value).toEqual(ref.preview.value);
      if (ref.preview.fields) for (const [path, field] of Object.entries(ref.preview.fields)) {
        const parsedField = accepted.preview.fields?.[path];
        expect(parsedField).toMatchObject({ present: field.present, truncated: field.truncated, count: field.count });
        if (field.present) expect(parsedField.value).toEqual(field.value);
      }
    }
    const { pipelineNodes, flattenPipelineNodes } = await import(join(dirname(process.env.PIPELINE_VIEWER_PARSER), "pipeline-viewer-projection.js"));
    const visible = flattenPipelineNodes(pipelineNodes(parsed.definition, parsed)).flatMap((node: { attempts: Array<{ id: string }> }) => node.attempts.map(attempt => attempt.id));
    for (const step of parsed.steps) expect(visible).toContain(step.id);
  }
  if (process.env.PIPELINE_VIEWER_FIXTURE_DIR) {
    mkdirSync(process.env.PIPELINE_VIEWER_FIXTURE_DIR, { recursive: true });
    writeFileSync(join(process.env.PIPELINE_VIEWER_FIXTURE_DIR, `${name}.json`), JSON.stringify(snapshot, null, 2) + "\n");
  }
  return snapshot;
}

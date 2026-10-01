import type { JsonObject, PipelineStore } from "./pipeline-store";

export function rootPipelineRunId(store: PipelineStore, runId: string): string {
  let parent = store.composition.parent(runId);
  while (parent) {
    runId = parent.parentRunId;
    parent = store.composition.parent(runId);
  }
  return runId;
}

export function pipelineAuthorityInput(store: PipelineStore, runId: string): JsonObject {
  const run = store.getRun(rootPipelineRunId(store, runId));
  if (!run) throw new Error("Missing pipeline authority run");
  return run.input;
}

export function assertPipelineAncestorsRunning(store: PipelineStore, runId: string): void {
  let parent = store.composition.parent(runId);
  while (parent) {
    if (store.getRun(parent.parentRunId)?.status !== "running") throw new Error("Parent pipeline is no longer running");
    if (Date.now() >= parent.deadline) throw new Error("Child pipeline timeout");
    parent = store.composition.parent(parent.parentRunId);
  }
}

export function inheritPipelineInvocation(store: PipelineStore, parentId: string, childId: string): void {
  const event = store.listEvents(parentId).find(entry => entry.type === "flightdeck_invocation_context");
  if (!event) return;
  if (typeof event.data_json !== "string") throw new Error("Invalid pipeline invocation context");
  store.addEvent({ runId: childId, level: "info", type: "flightdeck_invocation_context",
    message: "Inherited trusted Flight Deck invocation context", data: JSON.parse(event.data_json) });
}

export function assertPipelineReplyContext(store: PipelineStore, runId: string, selected: JsonObject): void {
  const rootId = rootPipelineRunId(store, runId);
  const event = store.listEvents(rootId).find(entry => entry.type === "flightdeck_invocation_context");
  if (!event) return;
  const trusted = JSON.parse(String(event.data_json)) as JsonObject;
  const original = pipelineAuthorityInput(store, runId);
  for (const key of ["workspaceId", "threadId", "frmNpub"] as const) {
    const value = key === "frmNpub" ? original[key] : trusted[key];
    if (typeof value !== "string" || selected[key] !== value) throw new Error(`Pipeline reply ${key} differs from trusted invocation`);
  }
}

import { createHash } from "node:crypto";
import type { PipelineRunRecord, PipelineStore } from "./pipeline-store";
import type { ResultDelivery } from "./public-call-store";

export const MAX_PIPELINE_WAIT_MS = 60_000;
export const PUBLIC_CALL_MODES = ["wait", "poll", "webhook"] as const;
export type PublicCallMode = typeof PUBLIC_CALL_MODES[number];

export function callError(message: string, code: string, status: number): Response {
  return Response.json({ error: message, code }, { status, headers: { "Cache-Control": "no-store" } });
}

export function publicDelivery(delivery: ResultDelivery | null) {
  if (!delivery) return null;
  const { payload: _payload, ...status } = delivery;
  return status;
}

export function runEnvelope(run: PipelineRunRecord) {
  return {
    runId: run.id,
    status: run.status,
    terminal: run.completedAt !== null,
    result: run.result,
    error: run.error,
    pollingUrl: `/api/pipelines/runs/${encodeURIComponent(run.id)}`,
    deliveryUrl: `/api/pipelines/runs/${encodeURIComponent(run.id)}/delivery`,
  };
}

export function callFingerprint(value: unknown): string {
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, canonical(val)]));
    }
    return item;
  }
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

/** The clock is injectable so a 60-second deadline can be tested without wall time. */
export async function waitForPublicRun(store: PipelineStore, runId: string, waitMs: number, clock = {
  now: () => performance.now(), sleep: (ms: number) => Bun.sleep(ms),
}): Promise<{ run: PipelineRunRecord; timedOut: boolean }> {
  const deadline = clock.now() + Math.min(MAX_PIPELINE_WAIT_MS, waitMs);
  for (;;) {
    const run = store.getRun(runId);
    if (!run) throw new Error(`Missing pipeline run ${runId}`);
    if (run.completedAt !== null) return { run, timedOut: false };
    const remaining = deadline - clock.now();
    if (remaining <= 0) return { run, timedOut: true };
    await clock.sleep(Math.min(25, remaining));
  }
}

export function responseSteps(store: PipelineStore, runId: string, includePayload = false) {
  const steps = includePayload ? store.listSteps(runId) : store.listStepSummaries(runId);
  return store.publicCalls.isPublic(runId) ? steps.map(step => ({ ...step, callbackToken: null })) : steps;
}

export function callResponse(store: PipelineStore, run: PipelineRunRecord, options: { status: number; timedOut?: boolean; replayed?: boolean }) {
  return Response.json({
    ...runEnvelope(run), run, steps: responseSteps(store, run.id, true),
    timedOut: options.timedOut ?? false, replayed: options.replayed ?? false,
  }, { status: options.status, headers: { "Location": runEnvelope(run).pollingUrl, "Cache-Control": "no-store" } });
}

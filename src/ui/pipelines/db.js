import Dexie from "/vendor/dexie/dexie.mjs";

const ACTIVE_RUN_STATUSES = new Set(["queued", "running"]);

export const pipelinesDb = new Dexie("WingmanPipelines");

pipelinesDb.version(1).stores({
  runDetails: "id, status, completedAt, updatedAt",
});

export function isActivePipelineRunStatus(status) {
  return ACTIVE_RUN_STATUSES.has(String(status ?? ""));
}

export async function getCachedRunDetail(runId) {
  if (!runId) return null;
  const cached = await pipelinesDb.runDetails.get(runId).catch(() => null);
  if (!cached || isActivePipelineRunStatus(cached.status)) return null;
  return cached.payload ?? null;
}

export async function cacheRunDetail(payload) {
  const run = payload?.run;
  if (!run?.id || isActivePipelineRunStatus(run.status)) return;
  await pipelinesDb.runDetails.put({
    id: run.id,
    status: run.status,
    completedAt: run.completedAt ?? run.completed_at ?? null,
    updatedAt: new Date().toISOString(),
    payload,
  });
}

export async function clearCachedRunDetail(runId) {
  if (!runId) return;
  await pipelinesDb.runDetails.delete(runId).catch(() => undefined);
}

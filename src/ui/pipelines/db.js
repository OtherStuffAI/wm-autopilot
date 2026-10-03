import Dexie from "/vendor/dexie/dexie.mjs";

const ACTIVE_RUN_STATUSES = new Set(["queued", "running"]);

export const pipelinesDb = new Dexie("WingmanPipelines");

pipelinesDb.version(1).stores({
  runDetails: "id, status, completedAt, updatedAt",
});
pipelinesDb.version(2).stores({
  runDetails: "id, status, completedAt, updatedAt",
}).upgrade(transaction => transaction.table("runDetails").clear());

export function isActivePipelineRunStatus(status) {
  return ACTIVE_RUN_STATUSES.has(String(status ?? ""));
}

export async function getCachedRunDetail(runId) {
  if (!runId) return null;
  const cached = await pipelinesDb.runDetails.get(runId).catch(() => null);
  if (!cached || isActivePipelineRunStatus(cached.status) || !cached.payload?.run?.input) return null;
  return cached.payload ?? null;
}

export async function cacheRunDetail(payload) {
  const run = payload?.run;
  if (!run?.id) throw new Error("Pipeline run response is missing its ID");
  await pipelinesDb.runDetails.put({
    id: run.id,
    status: run.status,
    completedAt: run.completedAt ?? run.completed_at ?? null,
    updatedAt: new Date().toISOString(),
    payload: { run: Object.fromEntries([
      "id", "name", "status", "startedAt", "completedAt", "definitionId", "tags",
      "definitionSlug", "definitionDefault",
    ].filter(key => Object.hasOwn(run, key)).map(key => [key, run[key]])), steps: [] },
  });
}

export async function clearCachedRunDetail(runId) {
  if (!runId) return;
  await pipelinesDb.runDetails.delete(runId).catch(() => undefined);
}

export async function getStoredRunDetail(runId) {
  const cached = await pipelinesDb.runDetails.get(runId);
  if (!cached?.payload) throw new Error("Pipeline run was not persisted in IndexedDB");
  return cached.payload;
}

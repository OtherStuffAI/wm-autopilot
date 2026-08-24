import {
  cacheRunDetail,
  clearCachedRunDetail,
  getCachedRunDetail,
  isActivePipelineRunStatus,
} from "./db.js";

export async function fetchPipelineRoot() {
  const res = await fetch("/api/pipelines/root", { credentials: "include" });
  if (!res.ok) throw new Error(`Failed to fetch pipeline root: ${res.status}`);
  return res.json();
}

export async function fetchPipelineDefinitions() {
  const res = await fetch("/api/pipelines/definitions", { credentials: "include" });
  if (!res.ok) throw new Error(`Failed to fetch pipeline definitions: ${res.status}`);
  return res.json();
}

export async function fetchPipelineRuns(options = {}) {
  const params = new URLSearchParams();
  if (options.includeDefinitionMeta === false) params.set("includeDefinitionMeta", "0");
  const query = params.toString();
  const res = await fetch(`/api/pipelines/runs${query ? `?${query}` : ""}`, { credentials: "include" });
  if (!res.ok) throw new Error(`Failed to fetch pipeline runs: ${res.status}`);
  return res.json();
}

export async function fetchPipelineFunctions() {
  const res = await fetch("/api/pipelines/functions", { credentials: "include" });
  if (!res.ok) throw new Error(`Failed to fetch pipeline functions: ${res.status}`);
  return res.json();
}

export async function fetchPipelineFunction(name) {
  const res = await fetch(`/api/pipelines/functions/${encodeURIComponent(name)}`, { credentials: "include" });
  if (!res.ok) throw new Error(`Failed to fetch pipeline function: ${res.status}`);
  return res.json();
}

export async function runPipelineDefinition(id, input = null) {
  const res = await fetch(`/api/pipelines/definitions/${encodeURIComponent(id)}/runs?async=1`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input ? { input } : {}),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `Failed to run pipeline: ${res.status}`);
  }
  return res.json();
}

export async function resumePipelineRunFromFailure(id) {
  const res = await fetch(`/api/pipelines/runs/${encodeURIComponent(id)}/resume-from-failure`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload.error || `Failed to resume pipeline run: ${res.status}`);
  }
  await clearCachedRunDetail(id);
  return payload;
}

export async function cancelPipelineRun(id, reason = "Pipeline run stopped by user") {
  const res = await fetch(`/api/pipelines/runs/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload.error || `Failed to stop pipeline run: ${res.status}`);
  }
  await clearCachedRunDetail(id);
  return payload;
}

export async function startPipelineWizard(prompt) {
  const res = await fetch("/api/pipelines/wizard", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `Failed to start pipeline wizard: ${res.status}`);
  }
  return res.json();
}

export async function startPipelineFunctionWizard(prompt) {
  const res = await fetch("/api/pipelines/functions/wizard", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `Failed to start function wizard: ${res.status}`);
  }
  return res.json();
}

export async function editPipelineWithWizard(id, prompt) {
  const res = await fetch(`/api/pipelines/definitions/${encodeURIComponent(id)}/wizard-edit`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `Failed to start pipeline edit wizard: ${res.status}`);
  }
  return res.json();
}

export async function saveManualPipelineEdit(id, edit) {
  const res = await fetch(`/api/pipelines/definitions/${encodeURIComponent(id)}/manual-edit`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(edit),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `Failed to save pipeline edit: ${res.status}`);
  }
  return res.json();
}

export async function fetchPipelineRun(id, options = {}) {
  const includeRunPayload = options.includeRunPayload === true;
  const forceFresh = options.forceFresh === true;
  if (includeRunPayload && !forceFresh) {
    const cached = await getCachedRunDetail(id);
    if (cached) return cached;
  }

  const params = new URLSearchParams();
  if (includeRunPayload) params.set("includeRunPayload", "1");
  if (options.includeStepPayload === true) params.set("includePayload", "1");
  const query = params.toString();
  const res = await fetch(`/api/pipelines/runs/${encodeURIComponent(id)}${query ? `?${query}` : ""}`, { credentials: "include" });
  if (!res.ok) throw new Error(`Failed to fetch pipeline run: ${res.status}`);
  const payload = await res.json();
  if (includeRunPayload) {
    if (isActivePipelineRunStatus(payload?.run?.status)) {
      await clearCachedRunDetail(id);
    } else {
      await cacheRunDetail(payload);
    }
  }
  return payload;
}

export async function fetchPipelineStep(runId, stepId) {
  const res = await fetch(
    `/api/pipelines/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}`,
    { credentials: "include" },
  );
  if (!res.ok) throw new Error(`Failed to fetch pipeline step: ${res.status}`);
  return res.json();
}

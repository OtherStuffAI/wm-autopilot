/**
 * Night Watch API Client
 *
 * Frontend functions for communicating with the Night Watch backend.
 */

export async function fetchNightWatchConfig() {
  const res = await fetch("/api/nightwatch/config");
  if (!res.ok) throw new Error(`Failed to fetch NW config: ${res.status}`);
  return res.json();
}

export async function updateNightWatchConfig({ model, maxCycles, prompt } = {}) {
  const body = {};
  if (model !== undefined) body.model = model;
  if (maxCycles !== undefined) body.maxCycles = maxCycles;
  if (prompt !== undefined) body.prompt = prompt;
  const res = await fetch("/api/nightwatch/config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Failed to update NW config: ${res.status}`);
  return res.json();
}

export async function fetchNightWatchSessionState(sessionId) {
  const res = await fetch(`/api/nightwatch/sessions/${encodeURIComponent(sessionId)}`);
  if (!res.ok) throw new Error(`Failed to fetch NW session state: ${res.status}`);
  return res.json();
}

export async function enableNightWatch(sessionId, opts = {}) {
  const body = {};
  if (opts.model) body.model = opts.model;
  if (opts.maxCycles) body.maxCycles = opts.maxCycles;
  if (opts.prompt) body.prompt = opts.prompt;
  if (opts.intervalMinutes !== undefined) body.intervalMinutes = opts.intervalMinutes;
  const res = await fetch(`/api/nightwatch/sessions/${encodeURIComponent(sessionId)}/enable`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Failed to enable NW: ${res.status}`);
  return res.json();
}

export async function disableNightWatch(sessionId) {
  const res = await fetch(`/api/nightwatch/sessions/${encodeURIComponent(sessionId)}/disable`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`Failed to disable NW: ${res.status}`);
  return res.json();
}

export async function fetchNightWatchReports() {
  const res = await fetch("/api/nightwatch/reports");
  if (!res.ok) throw new Error(`Failed to fetch NW reports: ${res.status}`);
  return res.json();
}

export async function deleteNightWatchReport(reportId) {
  const res = await fetch(`/api/nightwatch/reports/${encodeURIComponent(reportId)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 204) throw new Error(`Failed to delete NW report: ${res.status}`);
  return true;
}

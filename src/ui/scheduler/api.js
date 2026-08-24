/**
 * Scheduler API Client
 *
 * Frontend functions for communicating with the Scheduler backend.
 */

export async function fetchSchedulerJobs() {
  const res = await fetch("/api/scheduler/jobs");
  if (!res.ok) throw new Error(`Failed to fetch jobs: ${res.status}`);
  return res.json();
}

export async function createSchedulerJob(data) {
  const res = await fetch("/api/scheduler/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to create job: ${res.status}`);
  }
  return res.json();
}

export async function updateSchedulerJob(id, data) {
  const res = await fetch(`/api/scheduler/jobs/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to update job: ${res.status}`);
  }
  return res.json();
}

export async function deleteSchedulerJob(id) {
  const res = await fetch(`/api/scheduler/jobs/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`Failed to delete job: ${res.status}`);
  }
  return true;
}

export async function triggerSchedulerJob(id) {
  const res = await fetch(`/api/scheduler/jobs/${encodeURIComponent(id)}/trigger`, {
    method: "POST",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to trigger job: ${res.status}`);
  }
  return res.json();
}

export async function fetchSchedulerJobRuns(id) {
  const res = await fetch(`/api/scheduler/jobs/${encodeURIComponent(id)}/runs`);
  if (!res.ok) throw new Error(`Failed to fetch runs: ${res.status}`);
  return res.json();
}

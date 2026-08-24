async function parseJson(response) {
  return response.json().catch(() => null);
}

function resolveError(payload, fallback) {
  if (payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.trim().length > 0) {
    return payload.error.trim();
  }
  return fallback;
}

export async function fetchStarterProjectsApi() {
  const response = await fetch("/api/apps/starter-projects");
  const payload = await parseJson(response);
  if (!response.ok) {
    throw new Error(resolveError(payload, response.statusText || "Failed to load starter projects"));
  }
  return Array.isArray(payload?.starterProjects) ? payload.starterProjects : [];
}

export async function launchStarterProjectApi({
  starterId,
  name,
  githubOwner,
  githubRepo,
  private: privateRepo = true,
  protectBranches = true,
  createDeployedBranch = true,
}) {
  const response = await fetch("/api/apps/starter-projects/launch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      starterId,
      name,
      githubOwner,
      githubRepo,
      private: privateRepo,
      protectBranches,
      createDeployedBranch,
    }),
  });
  const payload = await parseJson(response);
  if (!response.ok) {
    throw new Error(resolveError(payload, response.statusText || "Failed to launch starter project"));
  }
  return payload;
}

export async function fetchAdminStarterProjectsApi() {
  const response = await fetch("/api/admin/starter-projects");
  const payload = await parseJson(response);
  if (!response.ok) {
    throw new Error(resolveError(payload, response.statusText || "Failed to load starter projects"));
  }
  return Array.isArray(payload?.starterProjects) ? payload.starterProjects : [];
}

export async function createAdminStarterProjectApi(input) {
  const response = await fetch("/api/admin/starter-projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const payload = await parseJson(response);
  if (!response.ok) {
    throw new Error(resolveError(payload, response.statusText || "Failed to create starter project"));
  }
  return payload?.starterProject ?? null;
}

export async function updateAdminStarterProjectApi(id, input) {
  const response = await fetch(`/api/admin/starter-projects/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const payload = await parseJson(response);
  if (!response.ok) {
    throw new Error(resolveError(payload, response.statusText || "Failed to update starter project"));
  }
  return payload?.starterProject ?? null;
}

export async function deleteAdminStarterProjectApi(id) {
  const response = await fetch(`/api/admin/starter-projects/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  const payload = await parseJson(response);
  if (!response.ok) {
    throw new Error(resolveError(payload, response.statusText || "Failed to delete starter project"));
  }
  return payload;
}

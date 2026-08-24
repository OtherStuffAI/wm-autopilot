/**
 * Apps API client - pure HTTP wrappers for apps-related endpoints.
 * These functions handle HTTP requests and return parsed data.
 * State and UI updates should be handled by the caller.
 */

/**
 * Fetches all apps with optional filtering.
 * @param {Object} options - Query options
 * @param {number} [options.tail=5] - Number of log lines to include
 * @param {string} [options.npub] - Filter by npub (admin only)
 * @returns {Promise<{apps: Array, filters?: Object} | {unauthorized: true}>}
 */
export async function fetchAppsApi(options = {}) {
  const { tail = 5, npub } = options;
  const searchParams = new URLSearchParams();
  searchParams.set("tail", String(tail));
  if (npub && npub !== "all") {
    searchParams.set("npub", npub);
  }

  const response = await fetch(`/api/apps?${searchParams.toString()}`);

  if (response.status === 401) {
    return { unauthorized: true, apps: [], filters: null };
  }

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error ?? response.statusText ?? "Failed to fetch apps");
  }

  return response.json();
}

/**
 * Fetches logs for a specific app.
 * @param {string} appId - The app ID
 * @param {number} [tail=200] - Number of log lines to fetch
 * @returns {Promise<{logs: string[]} | null>}
 */
export async function fetchAppLogsApi(appId, tail = 200) {
  const searchParams = new URLSearchParams();
  searchParams.set("tail", String(tail));

  const response = await fetch(`/api/apps/${encodeURIComponent(appId)}/logs?${searchParams.toString()}`);
  if (!response.ok) return null;
  return response.json();
}

/**
 * Triggers an action on an app.
 * @param {string} appId - The app ID
 * @param {string} action - The action to perform
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function triggerAppActionApi(appId, action) {
  const response = await fetch(`/api/apps/${encodeURIComponent(appId)}/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
        ? payload.error
        : response.statusText || "Failed to perform action";
    return { success: false, error: message };
  }
  return { success: true, data: payload };
}

/**
 * Removes an app from the system.
 * @param {string} appId - The app ID
 * @param {boolean} [killSession=false] - Whether to kill the tmux session
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function removeAppApi(appId, killSession = false) {
  let url = `/api/apps/${encodeURIComponent(appId)}`;
  if (killSession) {
    url += "?killSession=true";
  }
  const response = await fetch(url, { method: "DELETE" });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
        ? payload.error
        : response.statusText || "Failed to remove app";
    return { success: false, error: message };
  }
  return { success: true };
}

/**
 * Removes a WApp assignment and publishes its Flight Deck delete record.
 * @param {string} wappId - The WApp record ID
 * @returns {Promise<{success: boolean, error?: string, data?: Object}>}
 */
export async function removeWappApi(wappId) {
  const response = await fetch(`/api/wapps/${encodeURIComponent(wappId)}`, { method: "DELETE" });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
        ? payload.error
        : response.statusText || "Failed to remove WApp";
    return { success: false, error: message, data: payload };
  }
  return { success: true, data: payload };
}

/**
 * Imports KEY=value entries from an app root .env file into managed encrypted env.
 * @param {string} appId
 * @param {{filename?: string, overwrite?: boolean}} options
 * @returns {Promise<{success: boolean, error?: string, data?: Object}>}
 */
export async function importAppDotenvApi(appId, options = {}) {
  const response = await fetch(`/api/apps/${encodeURIComponent(appId)}/env/import-dotenv`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      filename: options.filename || ".env",
      overwrite: options.overwrite !== false,
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
        ? payload.error
        : response.statusText || "Failed to import .env";
    return { success: false, error: message, data: payload };
  }
  return { success: true, data: payload };
}

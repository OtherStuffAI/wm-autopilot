/**
 * Session API client - pure HTTP wrappers for session-related endpoints.
 * These functions handle HTTP requests and return parsed data.
 * State and UI updates should be handled by the caller.
 */

/**
 * Fetches all sessions with optional filtering.
 * @param {Object} options - Query options
 * @param {string} [options.npub] - Filter by npub
 * @returns {Promise<{sessions: Array, identities: Array, filters: Object} | null>}
 */
export async function fetchSessionsApi(options = {}) {
  const query = options.npub && options.npub !== "all"
    ? `?npub=${encodeURIComponent(options.npub)}`
    : "";
  const response = await fetch(`/api/sessions${query}`);

  if (response.status === 401) {
    return { unauthorized: true, sessions: [], identities: [], filters: null };
  }

  if (!response.ok) {
    console.error("Failed to load sessions:", response.status, response.statusText);
    return null;
  }

  return response.json();
}

/**
 * Fetches a single session by ID.
 * @param {string} sessionId - The session ID
 * @returns {Promise<Object | null>} Session data or null
 */
export async function fetchSessionApi(sessionId) {
  const response = await fetch(`/api/sessions/${sessionId}`);
  if (!response.ok) return null;
  return response.json();
}

/**
 * Fetches logs for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Promise<{logs: Array} | null>}
 */
export async function fetchSessionLogsApi(sessionId) {
  const response = await fetch(`/api/sessions/${sessionId}/logs`);
  if (!response.ok) return null;
  return response.json();
}

/**
 * Fetches conversation messages for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Promise<{messages: Array} | null>}
 */
export async function fetchSessionMessagesApi(sessionId, options = {}) {
  const query = options.refresh ? "?refresh=true" : "";
  const response = await fetch(`/api/sessions/${sessionId}/messages${query}`);
  if (!response.ok) return null;
  return response.json();
}

export async function fetchSessionPermissionsApi(sessionId) {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/permissions`);
  if (!response.ok) return null;
  return response.json();
}

export async function respondToSessionPermissionApi(sessionId, permissionId, responseValue) {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: responseValue }),
    },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error || response.statusText || "Failed to respond to permission");
  }
  return body;
}

/**
 * Fetches session history from any source (live, abandoned, or archived).
 * @param {string} sessionId - The session ID
 * @returns {Promise<{id: string, status: "live"|"abandoned"|"archived", session: Object, messages: Array} | null>}
 */
export async function fetchSessionHistoryApi(sessionId) {
  const response = await fetch(`/api/sessions/${sessionId}/history`);
  if (!response.ok) return null;
  return response.json();
}

/**
 * Stops a running session.
 * @param {string} sessionId - The session ID
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function stopSessionApi(sessionId) {
  const response = await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    return { success: false, error: data.error ?? response.statusText };
  }
  return { success: true };
}

/**
 * Deletes a session and its storage.
 * @param {string} sessionId - The session ID
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function deleteSessionApi(sessionId) {
  const response = await fetch(`/api/sessions/${sessionId}/storage`, { method: "DELETE" });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    return { success: false, error: data.error ?? response.statusText };
  }
  return { success: true };
}

export async function bulkCloseStaleAutoSessionsApi() {
  const response = await fetch("/api/sessions/bulk-close-stale-auto", { method: "POST" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error || response.statusText || "Failed to close auto sessions");
  }
  return body;
}

/**
 * Updates a session's name.
 * @param {string} sessionId - The session ID
 * @param {string} name - The new name
 * @param {number} [position] - Optional 1-based tab position
 * @returns {Promise<Object>} Updated session data
 * @throws {Error} If the request fails
 */
export async function updateSessionNameApi(sessionId, name, position) {
  const body = { name };
  if (typeof position === "number" && Number.isFinite(position)) {
    body.position = Math.max(1, Math.floor(position));
  }
  const response = await fetch(`/api/sessions/${sessionId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const message = typeof data?.error === "string" ? data.error : response.statusText;
    throw new Error(message || "Failed to rename session");
  }
  return response.json();
}

/**
 * Starts a new Wingman session by resuming the agent's native session id.
 * @param {string} sessionId - Source Wingman session ID
 * @returns {Promise<{session: Object}>}
 * @throws {Error} If the request fails
 */
export async function resumeNativeSessionApi(sessionId) {
  const response = await fetch(`/api/sessions/${sessionId}/resume-native`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const message = typeof data?.error === "string" ? data.error : response.statusText;
    throw new Error(message || "Failed to resume native session");
  }
  return response.json();
}

/**
 * Updates session metadata.
 * @param {string} sessionId - The session ID
 * @param {Object} metadata - Session metadata patch
 * @returns {Promise<{id: string, metadata: Object}>}
 * @throws {Error} If the request fails
 */
export async function updateSessionMetadataApi(sessionId, metadata) {
  const response = await fetch(`/api/sessions/${sessionId}/metadata`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(metadata),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const message = typeof data?.error === "string" ? data.error : response.statusText;
    throw new Error(message || "Failed to update session metadata");
  }
  return response.json();
}

/**
 * Persists the pinned artifact file for a session.
 * Pass null to clear the server-side pinned artifact.
 *
 * @param {string} sessionId - The session ID
 * @param {string | null} filePath - Absolute path to pin, or null to clear
 * @returns {Promise<{pinnedFile: string | null}>}
 * @throws {Error} If the request fails
 */
export async function setPinnedArtifactApi(sessionId, filePath) {
  const response = await fetch("/api/mcp/wingman/artifact/pin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, filePath }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const message = typeof data?.error === "string" ? data.error : response.statusText;
    throw new Error(message || "Failed to update pinned artifact");
  }
  return response.json();
}

export async function removePinnedArtifactApi(sessionId, filePath, options = {}) {
  const pinnedFiles = Array.isArray(options.pinnedFiles) ? options.pinnedFiles : null;
  const activeFilePath = typeof options.activeFilePath === "string" ? options.activeFilePath : null;
  const response = await fetch("/api/mcp/wingman/artifact/pin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId,
      removeFilePath: filePath,
      ...(pinnedFiles ? { pinnedFiles } : {}),
      ...(activeFilePath ? { activeFilePath } : {}),
    }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const message = typeof data?.error === "string" ? data.error : response.statusText;
    throw new Error(message || "Failed to unpin artifact");
  }
  return response.json();
}

/**
 * Posts a message to a session.
 * @param {string} sessionId - The session ID
 * @param {string} content - Message content
 * @param {string} [type="user"] - Message type ("user" or "raw")
 * @returns {Promise<{messages?: Array}>}
 * @throws {Error} If the request fails
 */
export async function postSessionMessageApi(sessionId, content, type = "user") {
  const payload = type === "user"
    ? { content }
    : { content, type };

  const response = await fetch(`/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const error = new Error(
      body && typeof body === "object" && typeof body.error === "string" && body.error.length > 0
        ? body.error
        : response.statusText || "Agent request failed"
    );
    error.status = response.status;
    throw error;
  }

  return body ?? {};
}

/**
 * Fetches the prompt queue for a session.
 * @param {string} sessionId - The session ID
 * @returns {Promise<{prompts: Array, maxSize: number} | null>}
 */
export async function fetchSessionQueueApi(sessionId) {
  try {
    const response = await fetch(`/api/sessions/${sessionId}/queue`);
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

/**
 * Adds a prompt to the session queue.
 * @param {string} sessionId - The session ID
 * @param {string} content - Prompt content
 * @returns {Promise<{prompts: Array, maxSize: number} | null>}
 */
export async function addToSessionQueueApi(sessionId, content) {
  const response = await fetch(`/api/sessions/${sessionId}/queue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error ?? response.statusText ?? "Failed to queue prompt");
  }
  return response.json();
}

/**
 * Removes a prompt from the session queue.
 * @param {string} sessionId - The session ID
 * @param {string} promptId - The prompt ID to remove
 * @returns {Promise<{prompts: Array, maxSize: number} | null>}
 */
export async function removeFromSessionQueueApi(sessionId, promptId) {
  const response = await fetch(`/api/sessions/${sessionId}/queue/${encodeURIComponent(promptId)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error ?? response.statusText ?? "Failed to remove queued prompt");
  }
  return response.json();
}

/**
 * Updates a prompt in the session queue.
 * @param {string} sessionId - The session ID
 * @param {string} promptId - The prompt ID to update
 * @param {string} content - New prompt content
 * @returns {Promise<{prompts: Array, maxSize: number} | null>}
 */
export async function updateSessionQueuePromptApi(sessionId, promptId, content) {
  const response = await fetch(`/api/sessions/${sessionId}/queue/${encodeURIComponent(promptId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error ?? response.statusText ?? "Failed to update queued prompt");
  }
  return response.json();
}

/**
 * Dispatches the next queued prompt for a session.
 * @param {string} sessionId - The session ID
 * @returns {Promise<{dispatched: boolean, promptId?: string, error?: string}>}
 */
export async function dispatchNextQueuedPromptApi(sessionId) {
  const response = await fetch(`/api/sessions/${sessionId}/queue/dispatch`, {
    method: "POST",
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    return { dispatched: false, error: data.error ?? response.statusText };
  }
  return response.json();
}

/**
 * Forks a session to a new git worktree.
 * Creates a new worktree branch, starts a new session in it, and returns
 * context messages for injection.
 * @param {string} sessionId - The source session ID
 * @param {string} branch - The branch name for the worktree
 * @param {number} [messageCount=5] - Number of recent messages to include as context
 * @returns {Promise<{session: Object, contextMessages: Array, worktreePath: string, initialPrompt: string}>}
 * @throws {Error} If the request fails
 */
export async function forkSessionToWorktreeApi(sessionId, branch, messageCount = 5) {
  const response = await fetch(`/api/sessions/${sessionId}/fork-to-worktree`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ branch, messageCount }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error ?? response.statusText ?? "Failed to fork to worktree");
  }

  return data;
}

/**
 * Branches a session conversation into a fresh session in the same directory.
 * Codex sessions are forked at the native transcript level before launch.
 * @param {string} sessionId - The source session ID
 * @param {{name?: string}} [options]
 * @returns {Promise<{session: Object, sourceSessionId: string, nativeAgentSession: Object, forkedCodexSession: Object}>}
 * @throws {Error} If the request fails
 */
export async function branchConversationApi(sessionId, options = {}) {
  const response = await fetch(`/api/sessions/${sessionId}/branch-conversation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: options.name,
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error ?? response.statusText ?? "Failed to branch conversation");
  }

  return data;
}

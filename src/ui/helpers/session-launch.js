import { showToast } from "../utils/toast.js";

const normalizeString = (value) => {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number") {
    return String(value);
  }
  return "";
};

export const buildSessionOrigin = ({ type, id, url, label }) => {
  const normalizedType = normalizeString(type);
  const normalizedId = normalizeString(id);
  if (!normalizedType || !normalizedId) {
    return null;
  }
  const origin = { type: normalizedType, id: normalizedId };
  const normalizedUrl = normalizeString(url);
  const normalizedLabel = normalizeString(label);
  if (normalizedUrl) {
    origin.url = normalizedUrl;
  }
  if (normalizedLabel) {
    origin.label = normalizedLabel;
  }
  return origin;
};

export const createSessionLauncher = ({ handleSessionStart, notify } = {}) => {
  if (typeof handleSessionStart !== "function") {
    throw new Error("handleSessionStart callback is required to launch sessions.");
  }
  const notifyUser =
    typeof notify === "function"
      ? notify
      : typeof document !== "undefined"
        ? (message, options) => showToast(message, options)
        : null;

  return async (agentId, workingDirectory, name, workspace, options = {}) => {
    const normalizedAgent = typeof agentId === "string" ? agentId.trim() : "";
    if (!normalizedAgent) {
      notifyUser?.("Select an agent before launching a session.", { type: "warning" });
      return;
    }

    const {
      origin = null,
      initialPrompt = null,
      targetFile = null,
      model = null,
      nightwatch = null,
      metadata = null,
    } = options ?? {};
    const payload = { agent: normalizedAgent };
    const trimmedName = typeof name === "string" ? name.trim() : "";
    if (trimmedName.length > 0) {
      payload.name = trimmedName.slice(0, 120);
    }
    if (typeof workingDirectory === "string" && workingDirectory.trim().length > 0) {
      payload.directory = workingDirectory.trim();
    }
    if (workspace && workspace.mode === "worktree" && workspace.name) {
      payload.workspace = { mode: "worktree", name: workspace.name };
    }
    if (origin && typeof origin === "object") {
      payload.origin = origin;
    }
    if (typeof initialPrompt === "string" && initialPrompt.trim().length > 0) {
      payload.initialPrompt = initialPrompt.trim();
    }
    if (typeof targetFile === "string" && targetFile.trim().length > 0) {
      payload.targetFile = targetFile.trim();
    }
    if (typeof model === "string" && model.trim().length > 0) {
      payload.model = model.trim();
    }
    if (nightwatch && typeof nightwatch === "object") {
      payload.nightwatch = nightwatch;
    }
    if (metadata && typeof metadata === "object") {
      payload.metadata = metadata;
    }

    const response = await fetch("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const message = `Failed to start session: ${data.error ?? response.statusText}`;
      notifyUser?.(message, { type: "error" });
      return;
    }

    const session = await response.json();
    if (session?.id) {
      // Keep the draft in localStorage so the composer can hydrate after route activation.
      if (typeof initialPrompt === "string" && initialPrompt.trim().length > 0) {
        try {
          localStorage.setItem(`session-draft-${session.id}`, initialPrompt.trim());
        } catch {
          // Ignore localStorage errors
        }
      }
    }
    await handleSessionStart(session);
  };
};

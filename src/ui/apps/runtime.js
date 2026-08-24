import { openConfirmDialog } from "../common/dialog-prompts.js";
import { createCopyIconButton } from "../utils/clipboard.js";
import { removeAppApi, removeWappApi, triggerAppActionApi } from "../services/apps.js";
import {
  runSystemCleanupApi,
  triggerRestartApi,
} from "../services/config.js";

export const APP_STATUS_LABELS = {
  idle: "Idle",
  running: "Running",
  stopping: "Stopping",
  restarting: "Restarting",
  building: "Building",
  "setting-up": "Setting Up",
  failed: "Failed",
};

export const APP_ACTION_LABELS = {
  start: "Start",
  stop: "Stop",
  restart: "Restart",
  setup: "Setup",
  build: "Build",
};

const APP_BUSY_STATUSES = new Set(["stopping", "restarting", "building", "setting-up"]);
const VARIABLE_URL_LOG_PREFIX = "[WINGMAN-URL]";
const VARIABLE_PUBKEY_LOG_PREFIX = "[WINGMAN-PUBKEY]";

export function initAppsRuntime({
  state,
  appsStore,
  getCurrentRoute,
  render,
  showToast,
  fetchSessions,
  logPreviewLines,
  onAppActionSuccess,
}) {
  async function fetchApps({ tail = logPreviewLines } = {}) {
    await appsStore().sync({ tail });
  }

  async function fetchRestartStatus() {
    if (!state.identity.isAdmin) {
      appsStore().system.restart.loading = false;
      appsStore().system.restart.inProgress = false;
      appsStore().system.restart.marker = null;
      appsStore().system.restart.outcome = null;
      appsStore().system.restart.error = null;
      return;
    }

    appsStore().system.restart.loading = true;
    try {
      const response = await fetch("/api/system/restart/status");
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
            ? payload.error
            : response.statusText || "Failed to load restart status";
        throw new Error(message);
      }
      appsStore().system.restart.inProgress = Boolean(payload?.inProgress);
      appsStore().system.restart.marker = payload?.marker ?? null;
      appsStore().system.restart.outcome = payload?.outcome ?? null;
      appsStore().system.restart.error = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load restart status";
      appsStore().system.restart.error = message;
    } finally {
      appsStore().system.restart.loading = false;
    }
  }

  async function refreshApps({ tail = logPreviewLines, skipRender = false } = {}) {
    if (state.identity.isAdmin) {
      await Promise.all([fetchApps({ tail }), fetchRestartStatus()]);
    } else {
      await fetchApps({ tail });
    }
    if (!skipRender && getCurrentRoute() === "apps") {
      render();
    }
  }

  function getAppById(appId) {
    return appsStore().items.find((item) => item?.id === appId) ?? null;
  }

  function formatAppActionLabel(action) {
    return APP_ACTION_LABELS[action] ?? action ?? "Unknown";
  }

  function formatAppTimestamp(value) {
    if (!value) return "—";
    try {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        return value;
      }
      return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
    } catch {
      return value;
    }
  }

  function isAppActionDisabled(app, action) {
    const status = app?.status;
    if (!status) return true;
    const available = Boolean(app?.availableScripts?.[action]);
    if (!available) return true;
    if (status.inProgressAction && status.inProgressAction !== action) {
      return true;
    }
    if (status.inProgressAction === action) {
      return true;
    }
    const statusValue = status.status;
    if (APP_BUSY_STATUSES.has(statusValue)) {
      return true;
    }
    if (action === "start") {
      return statusValue === "running";
    }
    if (action === "stop") {
      return statusValue !== "running";
    }
    if (action === "restart") {
      return false;
    }
    if (action === "setup") {
      return statusValue === "running";
    }
    if (action === "build") {
      return statusValue === "running";
    }
    return true;
  }

  async function triggerAppAction(appId, action) {
    const appBeforeAction = getAppById(appId);
    const result = await triggerAppActionApi(appId, action);
    if (!result.success) {
      showToast(result.error, { type: "error" });
      return false;
    }
    await refreshApps({ skipRender: getCurrentRoute() !== "apps" });
    if (typeof onAppActionSuccess === "function") {
      onAppActionSuccess({ app: getAppById(appId) ?? appBeforeAction ?? { id: appId }, appId, action });
    }
    if (getCurrentRoute() !== "apps") {
      render();
    }
    return true;
  }

  async function triggerRestart() {
    if (appsStore().system.restart.submitting || appsStore().system.restart.inProgress) {
      return false;
    }
    appsStore().system.restart.submitting = true;
    try {
      await triggerRestartApi();
      appsStore().system.restart.inProgress = true;
      appsStore().system.restart.error = null;
      await fetchRestartStatus();
      if (getCurrentRoute() === "apps") {
        render();
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to initiate restart";
      appsStore().system.restart.error = message;
      showToast(message, { type: "error" });
      return false;
    } finally {
      appsStore().system.restart.submitting = false;
    }
  }

  async function runSystemCleanup() {
    if (appsStore().system.cleanup.running) {
      return false;
    }
    appsStore().system.cleanup.running = true;
    appsStore().system.cleanup.error = null;
    if (getCurrentRoute() === "apps") {
      render();
    }
    try {
      const payload = await runSystemCleanupApi();
      appsStore().system.cleanup.result = payload;
      appsStore().system.cleanup.error = null;
      await Promise.all([fetchSessions(), refreshApps({ skipRender: true })]);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to stop agents and apps";
      appsStore().system.cleanup.error = message;
      showToast(message, { type: "error" });
      return false;
    } finally {
      appsStore().system.cleanup.running = false;
      if (getCurrentRoute() === "apps") {
        render();
      }
    }
  }

  async function removeApp(appId) {
    const app = getAppById(appId);
    if (!app) return;
    const confirmed = await openConfirmDialog({
      title: "Remove App",
      description: `Remove "${app.label ?? app.id}" from Wingman?`,
      confirmLabel: "Remove",
      testId: "remove-app-dialog",
    });
    if (!confirmed) return;

    const killSession = app?.status?.running
      ? await openConfirmDialog({
          title: "Kill Tmux Session",
          description: "The app appears to be running. Kill the tmux session as well?",
          confirmLabel: "Kill Session",
          testId: "remove-app-kill-session-dialog",
        })
      : false;

    const result = await removeAppApi(appId, killSession);
    if (!result.success) {
      showToast(result.error, { type: "error" });
      return;
    }
    await refreshApps({ skipRender: false });
  }

  async function removeWapp(wapp) {
    const wappId = typeof wapp?.id === "string" ? wapp.id : null;
    if (!wappId) return false;
    const label = typeof wapp?.title === "string" && wapp.title.trim().length > 0 ? wapp.title.trim() : wappId;
    const confirmed = await openConfirmDialog({
      title: "Remove WApp",
      description: `Remove "${label}" from Flight Deck? This publishes a deleted WApp record.`,
      confirmLabel: "Remove WApp",
      testId: "remove-wapp-dialog",
    });
    if (!confirmed) return false;

    const result = await removeWappApi(wappId);
    if (!result.success) {
      showToast(result.error, { type: "error" });
      return false;
    }
    showToast("WApp removed");
    await refreshApps({ skipRender: false });
    return true;
  }

  function deriveAppWindowName(labelValue, rootValue) {
    const label = (labelValue ?? "").trim();
    const root = (rootValue ?? "").trim();
    const basename = (input) => {
      if (!input) return "";
      const segments = input.split(/[\\/]/).filter(Boolean);
      return segments.length > 0 ? segments[segments.length - 1] : "";
    };
    const source = label || basename(root);
    const cleaned = source
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .slice(0, 48);
    return cleaned.length > 0 ? cleaned : "app";
  }

  function appendVariableUrlRow(metaContainer, logs) {
    if (!metaContainer) return;
    const variableUrl = extractVariableUrlFromLogs(logs);
    if (!variableUrl) return;

    const row = document.createElement("div");
    row.className = "wm-app-meta-row";

    const label = document.createElement("span");
    label.className = "wm-app-meta-label";
    label.textContent = "Variable URL";

    const value = document.createElement("span");
    value.className = "wm-app-meta-value";

    const link = document.createElement("a");
    link.href = variableUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = variableUrl;
    value.append(link);

    const copyButton = createCopyIconButton({
      text: variableUrl,
      ariaLabel: "Copy variable URL",
      title: "Copy variable URL",
    });
    value.append(copyButton);
    row.append(label, value);
    metaContainer.append(row);
  }

  function appendVariablePubkeyRow(metaContainer, logs) {
    if (!metaContainer) return;
    const pubkey = extractPubkeyFromLogs(logs);
    if (!pubkey) return;

    const row = document.createElement("div");
    row.className = "wm-app-meta-row";

    const label = document.createElement("span");
    label.className = "wm-app-meta-label";
    label.textContent = "Pubkey";

    const value = document.createElement("span");
    value.className = "wm-app-meta-value";

    const pubkeyDisplay = document.createElement("code");
    pubkeyDisplay.textContent = pubkey;
    value.append(pubkeyDisplay);

    const copyButton = createCopyIconButton({
      text: pubkey,
      ariaLabel: "Copy pubkey",
      title: "Copy pubkey",
    });

    value.append(copyButton);
    row.append(label, value);
    metaContainer.append(row);
  }

  function renderAppLogPreview(logs) {
    const preview = document.createElement("pre");
    preview.className = "wm-app-log";
    if (Array.isArray(logs) && logs.length > 0) {
      preview.textContent = logs.join("\n");
    } else {
      preview.textContent = "No recent logs.";
    }
    return preview;
  }

  return {
    fetchApps,
    fetchRestartStatus,
    refreshApps,
    getAppById,
    formatAppActionLabel,
    formatAppTimestamp,
    isAppActionDisabled,
    triggerAppAction,
    triggerRestart,
    runSystemCleanup,
    removeApp,
    removeWapp,
    deriveAppWindowName,
    appendVariableUrlRow,
    appendVariablePubkeyRow,
    renderAppLogPreview,
  };
}

function extractVariableUrlFromLogs(logs) {
  if (!Array.isArray(logs)) return null;
  for (const entry of logs) {
    if (typeof entry !== "string") continue;
    if (!entry.startsWith(VARIABLE_URL_LOG_PREFIX)) continue;
    const remainder = entry.slice(VARIABLE_URL_LOG_PREFIX.length).trim();
    if (!remainder) continue;
    const candidate = remainder.split(/\s+/)[0];
    try {
      const url = new URL(candidate);
      return url.toString();
    } catch {
      continue;
    }
  }
  return null;
}

function extractPubkeyFromLogs(logs) {
  if (!Array.isArray(logs)) return null;
  for (const entry of logs) {
    if (typeof entry !== "string") continue;
    if (!entry.startsWith(VARIABLE_PUBKEY_LOG_PREFIX)) continue;
    const remainder = entry.slice(VARIABLE_PUBKEY_LOG_PREFIX.length).trim();
    if (!remainder) continue;
    const candidate = remainder.split(/\s+/)[0];
    if (!candidate) continue;
    if (!/^[0-9a-fA-F]{64,130}$/.test(candidate)) continue;
    return candidate;
  }
  return null;
}

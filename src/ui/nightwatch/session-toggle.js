import {
  disableNightWatch,
  enableNightWatch,
  fetchNightWatchConfig,
  fetchNightWatchSessionState,
} from "./api.js";
import { openNightWatchEnableModal } from "./enable-modal.js";
import { updateSessionMetadataApi } from "../services/sessions.js";

export function getNightWatchToggleLabel(enabled) {
  return enabled ? "Night Watch: On" : "Night Watch: Off";
}

export function syncSessionMetadata(sessionMetadata, metadataResult) {
  if (!sessionMetadata || typeof sessionMetadata !== "object") {
    return;
  }
  const normalizedMetadata =
    metadataResult && typeof metadataResult === "object" && metadataResult.metadata
      ? metadataResult.metadata
      : {};
  Object.keys(sessionMetadata).forEach((key) => {
    if (!(key in normalizedMetadata)) {
      delete sessionMetadata[key];
    }
  });
  Object.assign(sessionMetadata, normalizedMetadata);
}

export async function ensureNightWatchSessionToggleLoaded({
  sessionId,
  state,
  onResolved,
} = {}) {
  const toggleMap = state?.nightwatch?.sessionToggles;
  if (!(toggleMap instanceof Map) || !sessionId || toggleMap.has(sessionId)) {
    return toggleMap?.get(sessionId) ?? null;
  }
  try {
    const data = await fetchNightWatchSessionState(sessionId);
    toggleMap.set(sessionId, data);
    if (typeof onResolved === "function") {
      onResolved(data);
    }
    return data;
  } catch {
    return null;
  }
}

export async function toggleNightWatchForSession({
  sessionId,
  sessionName,
  sessionMetadata,
  state,
  showToast,
  onChanged,
} = {}) {
  const toggleMap = state?.nightwatch?.sessionToggles;
  if (!(toggleMap instanceof Map) || !sessionId) {
    throw new Error("Night Watch state is unavailable");
  }
  const currentlyOn = toggleMap.get(sessionId)?.enabled ?? false;

  if (currentlyOn) {
    const result = await disableNightWatch(sessionId);
    const nextState = { enabled: false, ...result };
    toggleMap.set(sessionId, nextState);
    showToast?.("Night Watch disabled");
    onChanged?.(nextState);
    return nextState;
  }

  const [config, sessionState] = await Promise.all([
    fetchNightWatchConfig(),
    fetchNightWatchSessionState(sessionId).catch(() => null),
  ]);
  const nextSettings = await openNightWatchEnableModal({
    sessionName,
    prompt: sessionState?.prompt || config.prompt || "Any progress?",
    intervalMinutes:
      Number(sessionState?.intervalMinutes) || Number(config.intervalMinutes) || 5,
    minIntervalMinutes: Number(config.minIntervalMinutes) || 2,
    maxIntervalMinutes: Number(config.maxIntervalMinutes) || 60,
    maxCycles: Number(sessionState?.maxCycles) || Number(config.maxCycles) || 21,
    maxCycleOptions: config.maxCycleOptions || [6, 21, 256],
    goal: sessionMetadata?.goal || "",
    nextAction: sessionMetadata?.nextAction || "",
    nextActionTemplate: sessionMetadata?.nextActionTemplate || "",
  });
  if (!nextSettings) {
    return null;
  }

  const metadataResult = await updateSessionMetadataApi(sessionId, {
    goal: nextSettings.goal,
    nextAction: nextSettings.nextAction,
    nextActionTemplate: nextSettings.nextActionTemplate,
  });
  syncSessionMetadata(sessionMetadata, metadataResult);

  const result = await enableNightWatch(sessionId, nextSettings);
  const nextState = { enabled: true, ...result };
  toggleMap.set(sessionId, nextState);
  showToast?.("Night Watch enabled");
  onChanged?.(nextState);
  return nextState;
}

import {
  addPinnedFileForSession,
} from "../live/writer-panel-state.js";
import { openArtifactPaneForSession } from "../live/artifact-pane-state.js";

export function createCommandPaletteFileActions({
  state,
  sessionsStore,
  getCurrentRoute,
  getPathname,
  getSessionIdFromPath,
  setPinnedArtifact,
  setActiveSession,
  setCurrentRoute,
  render,
} = {}) {
  function getFileBrowserSession() {
    const ss = typeof sessionsStore === "function" ? sessionsStore() : null;
    const sessions = Array.isArray(ss?.items) ? ss.items : [];
    const pathname = typeof getPathname === "function" ? getPathname() : window.location.pathname;
    const routeSessionId = getCurrentRoute?.() === "live"
      ? getSessionIdFromPath?.(pathname)
      : null;
    const candidates = [
      routeSessionId,
      ss?.activeSessionId,
      ss?.lastActiveSessionId,
    ].filter(Boolean);

    for (const sessionId of candidates) {
      const session = sessions.find((entry) => entry?.id === sessionId);
      if (session) return session;
    }
    return null;
  }

  function getFileBrowserInitialPath() {
    const session = getFileBrowserSession();
    return session?.workingDirectory || state?.files?.currentPath || state?.config?.defaultDirectory || "";
  }

  async function pinFileToSession(filePath, { session: targetSession = null } = {}) {
    const session = targetSession?.id ? targetSession : getFileBrowserSession();
    if (!session?.id) {
      throw new Error("No active session is available to pin this file.");
    }
    const result = await setPinnedArtifact?.(session.id, filePath);
    const pinnedFile = result?.pinnedFile ?? null;
    session.pinnedFile = pinnedFile;
    if (Array.isArray(result?.pinnedFiles)) {
      session.metadata = { ...(session.metadata ?? {}), pinnedFiles: result.pinnedFiles };
    }
    if (pinnedFile) {
      if (state) {
        for (const file of Array.isArray(result?.pinnedFiles) ? result.pinnedFiles : [pinnedFile]) {
          addPinnedFileForSession(state, session.id, file);
        }
      }
    } else {
      state?.pinnedFiles?.delete(session.id);
    }
    if (pinnedFile) {
      setCurrentRoute?.("live");
      setActiveSession?.(session.id, { updateHistory: true, forceLog: true });
      openArtifactPaneForSession(state, session.id);
    }
    render?.();
    return pinnedFile;
  }

  return {
    getFileBrowserSession,
    getFileBrowserInitialPath,
    pinFileToSession,
  };
}

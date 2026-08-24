import {
  clearWriterDismissal,
  markWriterDismissed,
  setArtifactsPanelOpenForSession,
  setWriterPanelOpenForSession,
} from "./writer-panel-state.js";

export function openArtifactPaneForSession(state, sessionId) {
  if (!state || !sessionId) return false;
  if (!state.writerDismissedFiles) {
    state.writerDismissedFiles = new Map();
  }
  clearWriterDismissal(state, sessionId);
  setWriterPanelOpenForSession(state, sessionId, true);
  if (state.writerLayout) {
    state.writerLayout.mobileTab = "writer";
  }
  if (state.appCardLayout) {
    state.appCardLayout.open = false;
  }
  if (state.artifactsLayout) {
    setArtifactsPanelOpenForSession(state, sessionId, false);
  }
  if (state.webviewLayout) {
    state.webviewLayout.open = false;
  }
  return true;
}

export function closeArtifactPaneForSession(state, sessionId, filePath = null) {
  if (!state || !sessionId) return false;
  if (!state.writerDismissedFiles) {
    state.writerDismissedFiles = new Map();
  }
  if (filePath) {
    markWriterDismissed(state, sessionId, filePath);
  }
  setWriterPanelOpenForSession(state, sessionId, false);
  return true;
}

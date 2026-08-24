import { createWriterPanel } from "./writer-panel.js";
import { shouldUseTiptapForFile } from "./editor-mode.js";
import { createTiptapFilePanel } from "../tiptap/tiptap-file-panel.js";

export function createFileEditingPanel(sessionId, targetFile, deps = {}) {
  if (shouldUseTiptapForFile(targetFile)) {
    return createTiptapFilePanel(sessionId, targetFile, deps);
  }
  return createWriterPanel(sessionId, targetFile, deps);
}

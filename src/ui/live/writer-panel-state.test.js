import { describe, expect, test } from "bun:test";

import {
  addPinnedFileForSession,
  clearWriterDismissal,
  getPinnedFilePageForSession,
  getPinnedFileForSession,
  isArtifactsPanelOpenForSession,
  isWriterPanelOpenForSession,
  markWriterDismissed,
  removePinnedFileForSession,
  replacePinnedFilesForSession,
  setArtifactsPanelOpenForSession,
  setPinnedFilePageForSession,
  setWriterPanelOpenForSession,
  shouldAutoOpenWriter,
  syncArtifactsLayoutOpenForSession,
  syncPinnedFileForSession,
  syncWriterLayoutOpenForSession,
} from "./writer-panel-state.js";

function createState() {
  return {
    writerLayout: { open: false },
    artifactsLayout: { open: false },
    pinnedFiles: new Map(),
    pinnedFileLists: new Map(),
    pinnedFileIndexes: new Map(),
    writerOpenSessions: new Map(),
    artifactsOpenSessions: new Map(),
    writerDismissedFiles: new Map(),
  };
}

describe("writer-panel-state", () => {
  test("keeps a server-pinned artifact available while the panel is closed", () => {
    const state = createState();

    syncPinnedFileForSession(state, "session-1", "/tmp/spec.md");
    markWriterDismissed(state, "session-1", "/tmp/spec.md");

    expect(getPinnedFileForSession(state, "session-1", "/tmp/spec.md")).toBe("/tmp/spec.md");
    expect(shouldAutoOpenWriter(state, "session-1", "/tmp/spec.md")).toBe(false);
  });

  test("auto-opens again when the effective file changes", () => {
    const state = createState();

    markWriterDismissed(state, "session-1", "/tmp/spec.md");

    expect(shouldAutoOpenWriter(state, "session-1", "/tmp/updated-spec.md")).toBe(true);
  });

  test("clears dismissal state when the user explicitly reopens the writer", () => {
    const state = createState();

    markWriterDismissed(state, "session-1", "/tmp/spec.md");
    clearWriterDismissal(state, "session-1");

    expect(shouldAutoOpenWriter(state, "session-1", "/tmp/spec.md")).toBe(true);
  });

  test("keeps multiple pinned files scoped to a session and exposes the active page", () => {
    const state = createState();

    addPinnedFileForSession(state, "session-1", "/tmp/spec.md");
    addPinnedFileForSession(state, "session-1", "/tmp/notes.md");
    addPinnedFileForSession(state, "session-2", "/tmp/other.md");

    expect(getPinnedFilePageForSession(state, "session-1")).toEqual({
      files: ["/tmp/spec.md", "/tmp/notes.md"],
      activeIndex: 1,
      activeFile: "/tmp/notes.md",
    });
    expect(getPinnedFileForSession(state, "session-2")).toBe("/tmp/other.md");

    setPinnedFilePageForSession(state, "session-1", 0);

    expect(getPinnedFilePageForSession(state, "session-1")).toEqual({
      files: ["/tmp/spec.md", "/tmp/notes.md"],
      activeIndex: 0,
      activeFile: "/tmp/spec.md",
    });
    expect(state.pinnedFiles.get("session-1")).toBe("/tmp/spec.md");
  });

  test("server sync does not reset the active pinned page after paging", () => {
    const state = createState();

    addPinnedFileForSession(state, "session-1", "/tmp/spec.md");
    addPinnedFileForSession(state, "session-1", "/tmp/notes.md");
    setPinnedFilePageForSession(state, "session-1", 0);
    syncPinnedFileForSession(state, "session-1", "/tmp/notes.md");

    expect(getPinnedFilePageForSession(state, "session-1")).toEqual({
      files: ["/tmp/spec.md", "/tmp/notes.md"],
      activeIndex: 0,
      activeFile: "/tmp/spec.md",
    });
  });

  test("hydrates a server-provided pinned file list without leaking between sessions", () => {
    const state = createState();

    syncPinnedFileForSession(state, "session-1", ["/tmp/a.md", "/tmp/b.md"]);
    syncPinnedFileForSession(state, "session-2", ["/tmp/c.md"]);

    expect(getPinnedFilePageForSession(state, "session-1")).toEqual({
      files: ["/tmp/a.md", "/tmp/b.md"],
      activeIndex: 1,
      activeFile: "/tmp/b.md",
    });
    expect(getPinnedFilePageForSession(state, "session-2")).toEqual({
      files: ["/tmp/c.md"],
      activeIndex: 0,
      activeFile: "/tmp/c.md",
    });
  });

  test("keeps writer panel visibility scoped to the active session", () => {
    const state = createState();

    setWriterPanelOpenForSession(state, "session-1", true);

    expect(isWriterPanelOpenForSession(state, "session-1")).toBe(true);
    expect(isWriterPanelOpenForSession(state, "session-2")).toBe(false);

    syncWriterLayoutOpenForSession(state, "session-2");

    expect(state.writerLayout.open).toBe(false);
    expect(shouldAutoOpenWriter(state, "session-2", "/tmp/other.md")).toBe(true);
  });

  test("keeps generated artifacts panel visibility scoped to the active session", () => {
    const state = createState();

    setArtifactsPanelOpenForSession(state, "session-1", true);

    expect(isArtifactsPanelOpenForSession(state, "session-1")).toBe(true);
    expect(isArtifactsPanelOpenForSession(state, "session-2")).toBe(false);

    syncArtifactsLayoutOpenForSession(state, "session-2");

    expect(state.artifactsLayout.open).toBe(false);
  });

  test("removes one pinned file and keeps the next page active", () => {
    const state = createState();

    replacePinnedFilesForSession(state, "session-1", ["/tmp/one.md", "/tmp/two.md", "/tmp/three.md"], "/tmp/two.md");
    const page = removePinnedFileForSession(state, "session-1", "/tmp/two.md");

    expect(page).toEqual({
      files: ["/tmp/one.md", "/tmp/three.md"],
      activeIndex: 1,
      activeFile: "/tmp/three.md",
    });
    expect(state.pinnedFiles.get("session-1")).toBe("/tmp/three.md");
  });
});

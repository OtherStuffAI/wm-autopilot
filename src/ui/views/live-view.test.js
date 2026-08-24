import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const source = readFileSync(new URL("./live-view.js", import.meta.url), "utf8");

describe("live-view composition", () => {
  test("renders the transcript and composer without the retired session drawer", () => {
    expect(source).not.toContain("createLiveSessionDrawer");
    expect(source).not.toContain("Show Session Drawer");
    expect(source).not.toContain("Hide Session Drawer");
    expect(source).not.toContain("createLiveSessionToolbar");
    expect(source).toContain("main.append(scrollRegion);");
    expect(source).toContain("wrapper.append(main, composerEl);");
    expect(source).not.toContain("wrapper.append(drawer.aside)");
    expect(source).not.toContain("wrapper.append(drawer.backdrop)");
    expect(source).not.toContain("wrapper.append(drawer.modal)");
  });

  test("offers native resume from archived transcripts", () => {
    expect(source).toContain("canResumeNativeAgentSession(state.archivedSession.session)");
    expect(source).toContain("resume-native-archived-live-session");
    expect(source).toContain('archivedNativeResumePending ? "Resuming..." : "Resume"');
    expect(source).toContain("Resume agent session");
    expect(source).toContain("await resumeNativeSession(routeSessionId);");
    expect(source).not.toContain("Resume Native");
    expect(source).not.toContain("Resume native agent session");
  });

  test("describes existing session navigation as viewing a session", () => {
    expect(source).toContain("No live session selected. Launch a new agent or use the menu to view one.");
    expect(source).not.toContain("use the menu to resume one");
  });

  test("renders live sessions through the task dispatch tab preference", () => {
    expect(source).toContain('tabs.setAttribute("role", "tablist")');
    expect(source).toContain("filterTaskDispatchSessionsForTabs");
    expect(source).toContain("getTaskDispatchTabsVisible");
    expect(source).toContain("getVisibleTabSessions(getActiveSessions())");
    expect(source).not.toContain("wm-live-tab-groups");
    expect(source).not.toContain("filterSessionsForLiveTabGroup");
  });

  test("pins the live header fullscreen toggle in the tabs bar", () => {
    expect(source).toContain("createLiveHeaderFullscreenToggle");
    expect(source).toContain("getLiveHeaderCollapsed");
    expect(source).toContain("toggleLiveHeaderCollapsed");
    expect(source).toContain("panel.append(renderTabs");
  });

  test("renders raw terminal output through the menu preference", () => {
    expect(source).toContain("getRawTerminalOutputVisible");
    expect(source).toContain("appendRawTerminalOutput(scrollRegion, sessionId)");
    expect(source).toContain(": false;");
  });

  test("offers session id copying from the live command menu", () => {
    expect(source).toContain("copyTextToClipboard");
    expect(source).toContain('addCommand("Copy session ID"');
    expect(source).toContain('showToast(copied ? "Session ID copied" : "Unable to copy session ID"');
  });

  test("shows session context above the composer", () => {
    expect(source).toContain("wm-composer-context");
    expect(source).toContain("wm-composer-input-column");
    expect(source).toContain("renderComposerContext(sessionId)");
    expect(source).toContain("resolveSessionAgentLabel(session)");
  });

  test("reconciles a detached composer after session state refreshes", () => {
    expect(source).toContain("function reconcileLiveSessionUi()");
    expect(source).toContain("resolveLiveSessionUiReconciliation");
    expect(source).toContain("updateLivePanelsForSession(decision.sessionId)");
    expect(source).toContain("currentContext.replaceWith(renderComposerContext(decision.sessionId))");
  });

  test("blocks composer submission while an attachment is uploading", () => {
    expect(source).toContain("createComposerUploadState");
    expect(source).toContain("uploadState.blockSubmissionIfUploading()");
    expect(source).toContain('uploadStatus.dataset.testid = "composer-upload-status"');
    expect(source).toContain('submitLabel.textContent = uploading ? "Uploading\\u2026" : "Send"');
  });

  test("does not auto-open persisted pinned docs when switching tabs", () => {
    expect(source).toContain("const activePinnedFile = pinnedFilePage.activeFile ?? null");
    expect(source).toContain("if (!activePinnedFile && shouldAutoOpenWriter(state, sessionId, effectiveFile))");
  });

  test("fully rerenders tab switches while a split artifact viewer is mounted", () => {
    expect(source).toContain("function hasMountedLiveSplitPanel()");
    expect(source).toContain("function shouldRenderLiveForSessionSwitch(sessionId)");
    expect(source).toContain('document.querySelector(".wm-live-split")');
    expect(source).toContain("isWriterPanelOpenForSession(state, sessionId)");
    expect(source).toContain("isArtifactsPanelOpenForSession(state, sessionId)");
    expect(source).toContain("if (shouldRenderLiveForSessionSwitch(session.id))");
  });

  test("renders pinned artifact paging with filename, open, and unpin controls", () => {
    expect(source).toContain("removePinnedArtifactApi");
    expect(source).toContain("buildFilesPreviewRoutePath");
    expect(source).toContain("live-pinned-artifact-page-count");
    expect(source).toContain("live-pinned-artifact-open");
    expect(source).toContain("live-pinned-artifact-unpin");
    expect(source).toContain("toolbar.insertBefore(pinnedPager, toolbar.lastElementChild)");
  });

  test("keeps web app split state local after removing header toggles", () => {
    expect(source).toContain("const webApp = findWebAppForSession");
    expect(source).toContain("} else if (webApp && state.webviewLayout.open) {");
    expect(source).not.toContain("syncHeaderWebviewToggle");
  });

  test("waits for the agent turn to finish before generating speech", () => {
    expect(source).toContain("const isSessionReadyForSpeech = (session) =>");
    expect(source).toContain('runtimeStatus !== "running"');
    expect(source).toContain("if (isSessionReadyForSpeech(session))");
  });

  test("renders Codex working notes in archived conversations", () => {
    expect(source).toContain("renderWorkingNotesHtml");
    expect(source).toContain('role === "agent-context"');
    expect(source).toContain('if (role === "agent-context") return "Context";');
    expect(source).toContain("return isWorkingNotesMessage(message) ? \"assistant\" : role;");
    expect(source).toContain("workingNotesLabel: getWorkingNotesLabel(message)");
    expect(source).toContain("isWorkingNotesMessage(message)");
  });

  test("unpinned artifacts preserve the remaining ordered page list", () => {
    expect(source).toContain("const remainingPinnedFiles = pinnedFilesBeforeRemoval.filter");
    expect(source).toContain("const nextActiveFile = nextActiveIndex >= 0 ? remainingPinnedFiles[nextActiveIndex] : null");
    expect(source).toContain("pinnedFiles: remainingPinnedFiles");
    expect(source).toContain("activeFilePath: nextActiveFile");
    expect(source).toContain("await unpinPinnedArtifact(sessionId, pageState)");
  });

  test("can collapse the AI chat column while editing artifacts", () => {
    expect(source).toContain("createCollapsedChatRail");
    expect(source).toContain('state.writerLayout.mode === "chat-collapsed"');
    expect(source).toContain('state.writerLayout.mode = "chat-narrow"');
  });
});

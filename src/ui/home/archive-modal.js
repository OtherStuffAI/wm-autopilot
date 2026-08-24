import { createArchiveComponent } from "./archive.js";
import { canResumeNativeAgentSession } from "./native-session-resume.js";

export function showArchiveSessionsModal({
  resumeNativeSession,
  getSessionPendingAction,
  isSessionActionPending,
  withPendingSessionAction,
  showToast,
} = {}) {
  const existing = document.getElementById("archive-sessions-modal");
  if (typeof HTMLDialogElement === "function" && existing instanceof HTMLDialogElement && existing.open) {
    existing.close();
    existing.remove();
  } else {
    existing?.remove();
  }

  const dialog = document.createElement("dialog");
  dialog.id = "archive-sessions-modal";
  dialog.className = "wm-archive-sessions-modal";
  dialog.dataset.testid = "archive-sessions-modal";
  dialog.setAttribute("aria-labelledby", "archive-sessions-modal-title");

  const shell = document.createElement("div");
  shell.className = "wm-archive-sessions-modal__shell";

  const header = document.createElement("header");
  header.className = "wm-archive-sessions-modal__header";

  const titleWrap = document.createElement("div");
  const title = document.createElement("h2");
  title.id = "archive-sessions-modal-title";
  title.textContent = "Archive";
  const subtitle = document.createElement("p");
  subtitle.textContent = "Filter archived sessions, then select one to resume it from disk.";
  titleWrap.append(title, subtitle);

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "wm-button secondary wm-button--small";
  closeButton.textContent = "Close";
  closeButton.setAttribute("aria-label", "Close archive");
  closeButton.dataset.testid = "archive-sessions-modal-close";
  closeButton.addEventListener("click", () => dialog.close());

  header.append(titleWrap, closeButton);

  async function resumeSessionFromArchive(sessionId) {
    if (typeof resumeNativeSession !== "function") {
      return null;
    }
    const resumed = await resumeNativeSession(sessionId);
    if (resumed) {
      dialog.close();
    }
    return resumed;
  }

  const archiveComponent = createArchiveComponent({
    titleText: "Archived Sessions",
    collapsible: false,
    defaultCollapsed: false,
    storageKey: "wingman-archive-modal-collapsed",
    getSessionPendingAction,
    isSessionActionPending,
    withPendingSessionAction,
    resumeNativeSession: resumeSessionFromArchive,
    onViewSession: (session) => {
      if (!canResumeNativeAgentSession(session) || typeof resumeNativeSession !== "function") {
        showToast?.("This archived session cannot be resumed from disk.", { type: "warning" });
        return;
      }
      const runResume = async () => {
        await resumeSessionFromArchive(session.id);
      };
      if (typeof withPendingSessionAction === "function") {
        void withPendingSessionAction(session.id, "resume-native", runResume);
        return;
      }
      void runResume();
    },
  });

  shell.append(header, archiveComponent.element);
  dialog.append(shell);

  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      dialog.close();
    }
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
  });

  document.body.append(dialog);
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else if (typeof dialog.show === "function") {
    dialog.show();
  } else {
    dialog.setAttribute("open", "open");
  }

  void archiveComponent.refresh();
}

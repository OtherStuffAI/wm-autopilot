/**
 * Voice note capture for the live composer.
 *
 * Flow:
 * 1. Record audio in-browser.
 * 2. Upload/save it immediately on stop.
 * 3. Insert the saved link into the composer.
 * 4. Start transcription in the background and update the draft when ready.
 * 5. If the user sends while transcription is still pending, wait for it first.
 */

import { transcribeVoiceNoteApi, uploadVoiceNoteApi } from "../services/voice-notes.js";
import {
  buildTranscriptReplacement,
  buildVoiceNoteBlockPattern,
  buildVoiceNoteDraftBlock,
  findVoiceNoteLinks,
  getVoiceNoteMarkers,
  removeVoiceNoteComments,
  replacePendingTranscriptMarker,
  replaceVoiceNoteLinkWithTranscript,
  sanitizeTranscriptLabel,
} from "./voice-note-draft.js";

function getPreferredMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
  ];

  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }

  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }

  return "";
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function createDialogShell() {
  const dialog = document.createElement("dialog");
  dialog.className = "wm-voice-note-dialog";
  dialog.dataset.testid = "voice-note-dialog";
  dialog.innerHTML = `
    <form class="wm-voice-note-dialog__form" method="dialog">
      <div class="wm-voice-note-dialog__header">
        <div>
          <h2 class="wm-voice-note-dialog__title">Record voice note</h2>
          <p class="wm-voice-note-dialog__subtitle">Records from your microphone, uploads immediately, inserts a saved note into the composer, and starts transcription in the background.</p>
        </div>
        <button type="button" class="wm-voice-note-dialog__close" aria-label="Close voice note recorder" data-action="close">&times;</button>
      </div>
      <p class="wm-voice-note-dialog__status" role="status" aria-live="polite" data-testid="voice-note-status"></p>
      <div class="wm-voice-note-dialog__meter" aria-hidden="true">
        <span class="wm-voice-note-dialog__meter-dot"></span>
        <span class="wm-voice-note-dialog__meter-label" data-part="meter-label">Idle</span>
        <span class="wm-voice-note-dialog__timer" data-part="timer">00:00</span>
      </div>
      <label class="wm-voice-note-dialog__preview">
        <span class="wm-voice-note-dialog__preview-label">Saved note</span>
        <textarea class="wm-voice-note-dialog__transcript" readonly rows="6" data-testid="voice-note-transcript" placeholder="The saved voice note link will appear here after upload completes."></textarea>
      </label>
      <div class="wm-voice-note-dialog__actions">
        <button type="button" class="wm-button secondary" data-action="start" data-testid="voice-note-start">Start recording</button>
        <button type="button" class="wm-button" data-action="stop" data-testid="voice-note-stop" disabled>Stop</button>
        <button type="button" class="wm-button secondary" data-action="cancel" data-testid="voice-note-cancel">Cancel</button>
      </div>
    </form>
  `;
  return dialog;
}

export function initVoiceNotes(deps) {
  const {
    state,
    getSessionById,
    insertTextAtCursor,
    showToast,
  } = deps;

  let activeDialog = null;
  const voiceNoteTracker = new Map();

  function setDialogStatus(dialog, message, tone = "neutral") {
    const status = dialog.querySelector(".wm-voice-note-dialog__status");
    if (status) {
      status.textContent = message;
      status.dataset.state = tone;
    }
  }

  function setMeterState(dialog, stateText) {
    const label = dialog.querySelector('[data-part="meter-label"]');
    if (label) {
      label.textContent = stateText;
    }
  }

  function setTimer(dialog, elapsedMs) {
    const timer = dialog.querySelector('[data-part="timer"]');
    if (timer) {
      timer.textContent = formatDuration(elapsedMs);
    }
  }

  function setPreviewValue(dialog, value) {
    const preview = dialog.querySelector(".wm-voice-note-dialog__transcript");
    if (preview) {
      preview.value = value ?? "";
    }
  }

  function getSessionVoiceNotes(sessionId) {
    if (!voiceNoteTracker.has(sessionId)) {
      voiceNoteTracker.set(sessionId, new Map());
    }
    return voiceNoteTracker.get(sessionId);
  }

  function getPreviewContainer(sessionId) {
    return document
      .querySelector(`.wm-composer-shell[data-session-id="${sessionId}"]`)
      ?.querySelector(".wm-image-preview-container");
  }

  function updatePreviewContainerVisibility(sessionId) {
    const container = getPreviewContainer(sessionId);
    if (!container) return;
    container.style.display = container.children.length > 0 ? "flex" : "none";
  }

  function createVoiceNoteTile(sessionId, markerId, label) {
    const container = getPreviewContainer(sessionId);
    if (!container) return null;

    const tile = document.createElement("div");
    tile.className = "wm-voice-note-chip";
    tile.dataset.markerId = markerId;
    tile.dataset.testid = "voice-note-chip";
    tile.innerHTML = `
      <div class="wm-voice-note-chip__icon" aria-hidden="true">Mic</div>
      <div class="wm-voice-note-chip__body">
        <div class="wm-voice-note-chip__title">${sanitizeTranscriptLabel(label)}</div>
        <div class="wm-voice-note-chip__meta">
          <span class="wm-voice-note-chip__status" data-part="status">Uploading…</span>
        </div>
        <div class="wm-voice-note-chip__transcript" data-part="transcript" hidden></div>
      </div>
      <button type="button" class="wm-voice-note-chip__remove" aria-label="Remove voice note" data-part="remove">&times;</button>
    `;

    container.append(tile);
    updatePreviewContainerVisibility(sessionId);
    return tile;
  }

  function setTileStatus(tile, status, tone = "neutral") {
    const statusEl = tile?.querySelector('[data-part="status"]');
    if (statusEl) {
      statusEl.textContent = status;
      statusEl.dataset.state = tone;
    }
  }

  function setTileTranscript(tile, transcript) {
    const transcriptEl = tile?.querySelector('[data-part="transcript"]');
    if (transcriptEl) {
      transcriptEl.textContent = transcript ?? "";
      transcriptEl.hidden = !transcript;
    }
  }

  function getTextarea(sessionId) {
    const composerShell = document.querySelector(`.wm-composer-shell[data-session-id="${sessionId}"]`);
    const textarea = composerShell?.querySelector("textarea");
    return textarea instanceof HTMLTextAreaElement ? textarea : null;
  }

  function syncDraftToComposer(sessionId, nextDraft, options = {}) {
    const { notifyInput = false } = options;
    state.messageDrafts.set(sessionId, nextDraft);
    const textarea = getTextarea(sessionId);
    if (!textarea) return;
    textarea.value = nextDraft;
    if (notifyInput) {
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function removeVoiceNoteBlockFromDraft(text, markerId) {
    return String(text ?? "")
      .replace(buildVoiceNoteBlockPattern(markerId), "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function removeVoiceNote(sessionId, markerId) {
    const sessionMap = voiceNoteTracker.get(sessionId);
    const entry = sessionMap?.get(markerId);
    entry?.controller?.abort();
    entry?.tile?.remove();
    sessionMap?.delete(markerId);

    const currentDraft = state.messageDrafts.get(sessionId) ?? "";
    const nextDraft = removeVoiceNoteBlockFromDraft(currentDraft, markerId);
    syncDraftToComposer(sessionId, nextDraft, { notifyInput: true });
    updatePreviewContainerVisibility(sessionId);
  }

  function registerVoiceNote(sessionId, entry) {
    const sessionMap = getSessionVoiceNotes(sessionId);
    sessionMap.set(entry.markerId, entry);
    const removeButton = entry.tile?.querySelector('[data-part="remove"]');
    removeButton?.addEventListener("click", () => {
      removeVoiceNote(sessionId, entry.markerId);
    });
  }

  function updateDraftWithTranscript(sessionId, markerId, label, transcript) {
    const currentDraft = state.messageDrafts.get(sessionId) ?? "";
    const markers = getVoiceNoteMarkers(markerId);
    if (!currentDraft.includes(markers.start)) {
      return false;
    }
    const replacement = buildTranscriptReplacement(label, transcript);
    const nextDraft = replacePendingTranscriptMarker(currentDraft, markerId, replacement);
    syncDraftToComposer(sessionId, nextDraft, { notifyInput: true });
    return true;
  }

  function setButtonState(dialog, state) {
    const startButton = dialog.querySelector('[data-action="start"]');
    const stopButton = dialog.querySelector('[data-action="stop"]');
    const cancelButton = dialog.querySelector('[data-action="cancel"]');
    const closeButton = dialog.querySelector('[data-action="close"]');

    if (startButton) startButton.disabled = state !== "idle";
    if (stopButton) stopButton.disabled = state !== "recording";
    if (cancelButton) cancelButton.disabled = false;
    if (closeButton) closeButton.disabled = false;
  }

  async function closeDialog(dialog, options = {}) {
    if (!dialog.isConnected) {
      return;
    }
    const { skipClose = false } = options;
    if (!skipClose) {
      try {
        dialog.close();
      } catch {
        // Ignore close errors from detached dialogs.
      }
    }
    dialog.remove();
    if (activeDialog === dialog) {
      activeDialog = null;
    }
  }

  function stopStream(stream) {
    if (!stream) return;
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // Ignore track shutdown failures.
      }
    }
  }

  function findComposerTextarea(sessionId) {
    return document.querySelector(`.wm-composer-shell[data-session-id="${sessionId}"] textarea`);
  }

  function insertVoiceNoteReference(sessionId, markerId, reference) {
    const textarea = findComposerTextarea(sessionId);
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("Unable to find the live composer for this session");
    }

    const draftBlock = buildVoiceNoteDraftBlock(markerId, reference.label, reference.publicPath);
    const needsPrefix = textarea.value.length > 0 && !textarea.value.endsWith("\n");
    const textToInsert = needsPrefix ? `\n${draftBlock}\n` : `${draftBlock}\n`;
    insertTextAtCursor(textarea, textToInsert, sessionId);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus({ preventScroll: true });
  }

  async function startBackgroundTranscription(sessionId, entry) {
    try {
      setTileStatus(entry.tile, "Transcribing…", "processing");
      const response = await transcribeVoiceNoteApi({
        publicPath: entry.publicPath,
        signal: entry.controller.signal,
      });
      const transcript = typeof response?.transcript === "string" ? response.transcript.trim() : "";
      if (!transcript) {
        throw new Error("Voice note transcription returned no text");
      }
      entry.transcript = transcript;
      entry.status = "ready";
      updateDraftWithTranscript(sessionId, entry.markerId, entry.label, transcript);
      setTileStatus(entry.tile, "Transcript ready", "success");
      setTileTranscript(entry.tile, transcript);
      showToast?.("Voice note transcript ready", { duration: 2200 });
      return transcript;
    } catch (error) {
      if (entry.controller.signal.aborted) {
        return "";
      }
      entry.status = "error";
      entry.error = error instanceof Error ? error.message : String(error);
      setTileStatus(entry.tile, "Transcript failed", "error");
      setTileTranscript(entry.tile, entry.error);
      throw error;
    }
  }

  async function uploadRecording(dialog, sessionId, recordingBlob, fileName, mimeType, signal) {
    const session = getSessionById(sessionId);
    if (!session) {
      throw new Error("Unable to locate the live session");
    }

    setDialogStatus(dialog, "Uploading voice note...", "processing");
    setMeterState(dialog, "Uploading");
    setPreviewValue(dialog, "");

    const file = new File([recordingBlob], fileName, {
      type: mimeType || recordingBlob.type || "audio/webm",
    });

    const response = await uploadVoiceNoteApi({
      agent: session.agent,
      file,
      signal,
    });

    const reference =
      typeof response?.publicPath === "string" && response.publicPath.trim().length > 0
        ? {
            label: sanitizeTranscriptLabel(response?.name ?? fileName),
            publicPath: response.publicPath.trim(),
          }
        : null;

    if (!reference?.publicPath) {
      throw new Error("Voice note upload succeeded without a usable link");
    }

    const markerId = `voice_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const tile = createVoiceNoteTile(sessionId, markerId, reference.label);
    const entry = {
      markerId,
      label: reference.label,
      publicPath: reference.publicPath,
      tile,
      status: "pending",
      transcript: "",
      error: null,
      controller: new AbortController(),
      promise: null,
    };
    registerVoiceNote(sessionId, entry);
    setTileStatus(tile, "Saved. Starting transcription…", "processing");
    insertVoiceNoteReference(sessionId, markerId, reference);
    entry.promise = startBackgroundTranscription(sessionId, entry);

    setPreviewValue(dialog, `[${reference.label}](${reference.publicPath})`);
    setDialogStatus(dialog, "Voice note saved to the composer. Transcription is running in the background.", "success");
    setMeterState(dialog, "Saved");
    showToast?.("Voice note saved to composer", { duration: 2200 });
  }

  function cleanupOrphanedVoiceNotes(sessionId, text) {
    const sessionMap = voiceNoteTracker.get(sessionId);
    if (!sessionMap || sessionMap.size === 0) {
      return;
    }
    const currentText = String(text ?? "");
    const markerIdsToRemove = [];
    for (const [markerId] of sessionMap.entries()) {
      const markers = getVoiceNoteMarkers(markerId);
      if (!currentText.includes(markers.start)) {
        markerIdsToRemove.push(markerId);
      }
    }
    markerIdsToRemove.forEach((markerId) => {
      const entry = sessionMap.get(markerId);
      entry?.controller?.abort();
      entry?.tile?.remove();
      sessionMap.delete(markerId);
    });
    updatePreviewContainerVisibility(sessionId);
  }

  async function prepareDraftForSend(sessionId, draft) {
    const matches = findVoiceNoteLinks(draft);
    if (matches.length === 0) {
      return removeVoiceNoteComments(draft);
    }

    let nextDraft = draft;
    const sessionMap = getSessionVoiceNotes(sessionId);
    showToast?.(
      `Transcribing ${matches.length} voice note${matches.length === 1 ? "" : "s"} before send`,
      { variant: "info", duration: 2200 },
    );

    for (const match of matches) {
      let transcript = "";
      const liveEntry = Array.from(sessionMap.values()).find((entry) => entry.publicPath === match.publicPath);
      if (liveEntry) {
        if (liveEntry.status === "pending" && liveEntry.promise) {
          transcript = await liveEntry.promise;
        } else if (liveEntry.status === "ready") {
          transcript = liveEntry.transcript;
        } else if (liveEntry.status === "error") {
          throw new Error(liveEntry.error || `Voice note transcription failed for ${match.label}`);
        }
      } else {
        const response = await transcribeVoiceNoteApi({ publicPath: match.publicPath });
        transcript = typeof response?.transcript === "string" ? response.transcript.trim() : "";
      }

      if (!transcript) {
        const response = await transcribeVoiceNoteApi({ publicPath: match.publicPath });
        transcript = typeof response?.transcript === "string" ? response.transcript.trim() : "";
        if (!transcript) {
          throw new Error(`Voice note transcription returned no text for ${match.label}`);
        }
      }

      nextDraft = replaceVoiceNoteLinkWithTranscript(nextDraft, match, transcript);
    }

    return removeVoiceNoteComments(nextDraft);
  }

  async function openVoiceNoteRecorder(sessionId) {
    const session = getSessionById(sessionId);
    if (!session) {
      showToast("Unable to locate session for voice note recording.", { type: "error" });
      return;
    }

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      showToast("Voice note recording is not supported in this browser.", { type: "warning" });
      return;
    }

    if (activeDialog) {
      activeDialog.focus();
      return;
    }

    const dialog = createDialogShell();
    activeDialog = dialog;
    document.body.append(dialog);
    dialog.showModal();

    const startButton = dialog.querySelector('[data-action="start"]');
    const stopButton = dialog.querySelector('[data-action="stop"]');
    const cancelButton = dialog.querySelector('[data-action="cancel"]');
    const closeButton = dialog.querySelector('[data-action="close"]');

    let uploadAbortController = new AbortController();
    let mediaStream = null;
    let mediaRecorder = null;
    let recordingChunks = [];
    let recordingMimeType = "";
    let recordingStartedAt = 0;
    let recordingTimer = null;
    let discardOnStop = false;
    let recordingState = "idle";

    const updateState = (nextState) => {
      recordingState = nextState;
      dialog.dataset.state = nextState;
      setButtonState(dialog, nextState);
      if (nextState === "idle") {
        setMeterState(dialog, "Idle");
        setTimer(dialog, 0);
      }
    };

    const teardownRecording = () => {
      if (recordingTimer) {
        window.clearInterval(recordingTimer);
        recordingTimer = null;
      }
      stopStream(mediaStream);
      mediaStream = null;
      mediaRecorder = null;
      recordingChunks = [];
    };

    const finishAndClose = () => {
      window.setTimeout(() => {
        void closeDialog(dialog);
      }, 700);
    };

    const cancelUploadAndClose = () => {
      uploadAbortController.abort();
      teardownRecording();
      setDialogStatus(dialog, "Voice note cancelled.", "warning");
      setMeterState(dialog, "Cancelled");
      updateState("idle");
      void closeDialog(dialog);
    };

    const startRecording = async () => {
      if (recordingState !== "idle") {
        return;
      }

      discardOnStop = false;
      uploadAbortController = new AbortController();
      setDialogStatus(dialog, "Requesting microphone access...", "processing");
      setMeterState(dialog, "Preparing");
      setPreviewValue(dialog, "");

      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        recordingMimeType = getPreferredMimeType();
        mediaRecorder = recordingMimeType
          ? new MediaRecorder(mediaStream, { mimeType: recordingMimeType })
          : new MediaRecorder(mediaStream);
        recordingChunks = [];
        recordingStartedAt = Date.now();
        updateState("recording");
        setDialogStatus(dialog, "Recording voice note...", "recording");
        setMeterState(dialog, "Recording");
        setTimer(dialog, 0);

        recordingTimer = window.setInterval(() => {
          setTimer(dialog, Date.now() - recordingStartedAt);
        }, 250);

        mediaRecorder.addEventListener("dataavailable", (event) => {
          if (event.data && event.data.size > 0) {
            recordingChunks.push(event.data);
          }
        });

        mediaRecorder.addEventListener("stop", async () => {
          const finalMimeType = recordingMimeType || mediaRecorder?.mimeType || "audio/webm";
          const recordingBlob = new Blob(recordingChunks, { type: finalMimeType });
          const fileName = `voice-note-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;

          teardownRecording();

          if (discardOnStop) {
            setDialogStatus(dialog, "Voice note discarded.", "warning");
            setMeterState(dialog, "Discarded");
            updateState("idle");
            finishAndClose();
            return;
          }

          if (recordingBlob.size === 0) {
            setDialogStatus(dialog, "No audio was captured. Please try again.", "error");
            setMeterState(dialog, "Error");
            updateState("idle");
            return;
          }

          try {
            dialog.dataset.busy = "true";
            updateState("uploading");
            await uploadRecording(dialog, sessionId, recordingBlob, fileName, finalMimeType, uploadAbortController.signal);
            dialog.dataset.busy = "false";
            finishAndClose();
          } catch (error) {
            dialog.dataset.busy = "false";
            const message = error instanceof Error ? error.message : String(error);
            setDialogStatus(dialog, `Voice note failed: ${message}`, "error");
            setMeterState(dialog, "Error");
            updateState("idle");
            showToast?.(`Voice note failed: ${message}`, { variant: "error", duration: 2600 });
          }
        }, { once: true });

        mediaRecorder.addEventListener("error", (event) => {
          const message = event.error instanceof Error ? event.error.message : "Recorder error";
          teardownRecording();
          setDialogStatus(dialog, `Recording failed: ${message}`, "error");
          setMeterState(dialog, "Error");
          updateState("idle");
          showToast?.(`Voice note recording failed: ${message}`, { variant: "error", duration: 2600 });
        }, { once: true });

        mediaRecorder.start(1000);
      } catch (error) {
        teardownRecording();
        updateState("idle");
        const message = error instanceof Error ? error.message : String(error);
        setDialogStatus(dialog, `Recording failed: ${message}`, "error");
        setMeterState(dialog, "Error");
        showToast?.(`Voice note recording failed: ${message}`, { variant: "error", duration: 2600 });
      }
    };

    const stopRecording = () => {
      if (!mediaRecorder || recordingState !== "recording") {
        return;
      }
      setDialogStatus(dialog, "Stopping recording...", "processing");
      setMeterState(dialog, "Stopping");
      try {
        mediaRecorder.stop();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setDialogStatus(dialog, `Stop failed: ${message}`, "error");
        setMeterState(dialog, "Error");
        updateState("idle");
      }
    };

    const cancelRecorder = () => {
      if (recordingState === "recording") {
        discardOnStop = true;
        setDialogStatus(dialog, "Discarding recording...", "warning");
        setMeterState(dialog, "Discarding");
        try {
          mediaRecorder?.stop();
        } catch {
          teardownRecording();
          updateState("idle");
          void closeDialog(dialog);
        }
        return;
      }

      if (recordingState === "uploading") {
        cancelUploadAndClose();
        return;
      }

      teardownRecording();
      void closeDialog(dialog);
    };

    startButton?.addEventListener("click", () => {
      void startRecording();
    });

    stopButton?.addEventListener("click", () => {
      stopRecording();
    });

    cancelButton?.addEventListener("click", () => {
      cancelRecorder();
    });

    closeButton?.addEventListener("click", () => {
      cancelRecorder();
    });

    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      cancelRecorder();
    });

    dialog.addEventListener("close", () => {
      teardownRecording();
      if (activeDialog === dialog) {
        activeDialog = null;
      }
      dialog.remove();
    }, { once: true });

    setDialogStatus(dialog, "Choose Start recording when you are ready.", "neutral");
    setMeterState(dialog, "Idle");
    setTimer(dialog, 0);
    setButtonState(dialog, "idle");

    requestAnimationFrame(() => {
      startButton?.focus();
    });
  }

  return {
    openVoiceNoteRecorder,
    cleanupOrphanedVoiceNotes,
    prepareDraftForSend,
  };
}

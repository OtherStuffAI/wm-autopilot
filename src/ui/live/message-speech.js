import { generateMessageSpeechApi } from "../services/message-speech.js";
import { fetchSessionMessagesApi } from "../services/sessions.js";
import { MessageStore } from "./db.js";

const generatedSpeech = new Map();
const speechRequests = new Map();
const autoPlayedMessages = new Set();
const autoReadingMessages = new Set();
const autoReadTimers = new Map();
let activeAudio = null;
let activeSpeechKey = "";
let activeSpeechModal = null;
let activeSpeechPendingKey = "";
const AUTO_READ_IDLE_MS = 1400;
const PLAY_ICON_SVG =
  '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
const STOP_ICON_SVG =
  '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M6 6h12v12H6z"/></svg>';

function isAssistantRole(message) {
  const role = String(message?.role ?? message?.type ?? "").toLowerCase();
  return role === "assistant" || role === "agent";
}

function getMessageId(message) {
  const id =
    typeof message?.messageId === "string"
      ? message.messageId.trim()
      : typeof message?.message_id === "string"
        ? message.message_id.trim()
        : typeof message?.id === "string"
          ? message.id.trim()
          : "";
  return id || "";
}

function getMessageText(message) {
  return String(message?.content ?? message?.message ?? "").replace(/\s+/g, " ").trim();
}

function getMessageCreatedAt(message) {
  return String(message?.createdAt ?? message?.created_at ?? "").trim();
}

function getSpeech(message) {
  return message?.speech && typeof message.speech === "object" ? message.speech : null;
}

function isReadableAssistantMessage(message) {
  return isAssistantRole(message) && Boolean(getMessageText(message));
}

export function hasMessageSpeech(message) {
  return Boolean(getSpeech(message)?.publicPath);
}

function getSpeechCacheKey(sessionId, message) {
  const createdAt = getMessageCreatedAt(message);
  const text = getMessageText(message);
  if (createdAt && text) {
    return `${sessionId}:${createdAt}:${text.slice(0, 80)}`;
  }
  const messageId = getMessageId(message);
  return messageId ? `${sessionId}:${messageId}` : "";
}

export function getMessageSpeechKey(sessionId, message) {
  return getSpeechCacheKey(sessionId, message);
}

export function getLatestAssistantSpeechKey(sessionId, conversation) {
  if (!sessionId || !Array.isArray(conversation)) {
    return "";
  }
  const latest = [...conversation].reverse().find((message) => isAssistantRole(message) && getMessageText(message));
  return latest ? getSpeechCacheKey(sessionId, latest) : "";
}

function isSameMessageCandidate(candidate, message) {
  if (!candidate || !message) {
    return false;
  }
  const role = String(candidate.role ?? candidate.type ?? "").toLowerCase();
  const targetRole = String(message.role ?? message.type ?? "").toLowerCase();
  if (role !== targetRole) {
    return false;
  }
  const createdAt = getMessageCreatedAt(message);
  if (createdAt && getMessageCreatedAt(candidate) === createdAt) {
    return true;
  }
  const targetText = getMessageText(message);
  const candidateText = getMessageText(candidate);
  return Boolean(targetText && candidateText && candidateText === targetText);
}

async function resolveServerMessage(sessionId, message) {
  const explicitId = getMessageId(message);
  if (explicitId) {
    return { ...message, messageId: explicitId };
  }

  const payload = await fetchSessionMessagesApi(sessionId, { refresh: true });
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const match = messages.find((candidate) => isSameMessageCandidate(candidate, message));
  const matchId = getMessageId(match);
  return matchId ? { ...match, messageId: matchId } : null;
}

function stopActiveAudio() {
  if (!activeAudio) {
    return;
  }
  const stoppedAudio = activeAudio;
  try {
    stoppedAudio.pause();
    stoppedAudio.currentTime = 0;
  } catch {
    // Ignore browser audio state errors.
  }
  activeAudio = null;
  dispatchSpeechPlaybackChange(null);
  if (typeof speechSynthesis !== "undefined") {
    speechSynthesis.cancel();
  }
}

function dispatchSpeechPlaybackChange(key) {
  activeSpeechKey = key || "";
  syncSpeechPlaybackModal(activeSpeechKey);
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") {
    return;
  }
  window.dispatchEvent(new CustomEvent("speech-playback-change", {
    detail: { key },
  }));
}

function removeSpeechPlaybackModal() {
  activeSpeechModal?.remove();
  activeSpeechModal = null;
}

function closePendingSpeechModal() {
  activeSpeechPendingKey = "";
  removeSpeechPlaybackModal();
}

function formatSpeechTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0:00";
  }
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function getSpeechSeekableEnd(audio) {
  const ranges = audio?.seekable;
  if (!ranges?.length) {
    return 0;
  }
  try {
    return ranges.end(ranges.length - 1);
  } catch {
    return 0;
  }
}

function updateSpeechTimeline(audio = activeAudio) {
  if (!activeSpeechModal || !audio) {
    return;
  }
  const scrubber = activeSpeechModal.querySelector("[data-part='speech-scrubber']");
  const elapsed = activeSpeechModal.querySelector("[data-part='speech-elapsed']");
  const duration = activeSpeechModal.querySelector("[data-part='speech-duration']");
  const currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  const reportedDuration = Number.isFinite(audio.duration) ? audio.duration : 0;
  const seekableEnd = getSpeechSeekableEnd(audio);
  const totalTime = Math.max(reportedDuration, seekableEnd, currentTime);
  if (scrubber) {
    scrubber.max = totalTime > 0 ? String(Math.ceil(totalTime)) : "0";
    scrubber.value = String(Math.floor(currentTime));
    scrubber.disabled = totalTime <= 0;
  }
  if (elapsed) {
    elapsed.textContent = formatSpeechTime(currentTime);
  }
  if (duration) {
    duration.textContent = totalTime > 0 ? formatSpeechTime(totalTime) : "--:--";
  }
}

function configureSpeechPlaybackModal(overlay, stateName) {
  overlay.dataset.state = stateName;
  const isPending = stateName === "pending";
  const title = overlay.querySelector("[data-part='speech-title']");
  const actionButton = overlay.querySelector("[data-part='speech-action']");
  const timeline = overlay.querySelector("[data-part='speech-timeline']");
  if (title) {
    title.textContent = isPending ? "Summarising" : "Audio playing";
  }
  if (actionButton) {
    actionButton.textContent = isPending ? "Close" : "Stop";
    actionButton.setAttribute("aria-label", isPending ? "Close speech summary status" : "Stop spoken summary");
  }
  if (timeline) {
    timeline.hidden = isPending;
  }
}

function syncSpeechPlaybackModal(key, stateName = "playing") {
  if (typeof document === "undefined") {
    return;
  }
  if (!key) {
    removeSpeechPlaybackModal();
    return;
  }
  if (activeSpeechModal?.isConnected) {
    activeSpeechModal.dataset.speechKey = key;
    configureSpeechPlaybackModal(activeSpeechModal, stateName);
    return;
  }

  const overlay = document.createElement("div");
  overlay.className = "wm-speech-playback-modal";
  overlay.dataset.speechKey = key;
  overlay.dataset.state = stateName;
  overlay.dataset.testid = "speech-playback-modal";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "speech-playback-title");

  const panel = document.createElement("div");
  panel.className = "wm-speech-playback-modal__panel";

  const status = document.createElement("div");
  status.className = "wm-speech-playback-modal__status";
  status.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 4; index += 1) {
    const bar = document.createElement("span");
    status.append(bar);
  }

  const title = document.createElement("p");
  title.id = "speech-playback-title";
  title.className = "wm-speech-playback-modal__title";
  title.dataset.part = "speech-title";

  const timeline = document.createElement("div");
  timeline.className = "wm-speech-playback-modal__timeline";
  timeline.dataset.part = "speech-timeline";

  const elapsed = document.createElement("span");
  elapsed.className = "wm-speech-playback-modal__time";
  elapsed.dataset.part = "speech-elapsed";
  elapsed.textContent = "0:00";

  const scrubber = document.createElement("input");
  scrubber.type = "range";
  scrubber.min = "0";
  scrubber.max = "0";
  scrubber.value = "0";
  scrubber.step = "1";
  scrubber.className = "wm-speech-playback-modal__scrubber";
  scrubber.dataset.part = "speech-scrubber";
  scrubber.dataset.testid = "speech-playback-scrubber";
  scrubber.setAttribute("aria-label", "Speech playback timeline");
  scrubber.disabled = true;
  scrubber.addEventListener("input", () => {
    if (!activeAudio) {
      return;
    }
    const nextTime = Number(scrubber.value);
    if (Number.isFinite(nextTime)) {
      activeAudio.currentTime = nextTime;
      updateSpeechTimeline(activeAudio);
    }
  });

  const duration = document.createElement("span");
  duration.className = "wm-speech-playback-modal__time";
  duration.dataset.part = "speech-duration";
  duration.textContent = "--:--";

  timeline.append(elapsed, scrubber, duration);

  const stopButton = document.createElement("button");
  stopButton.type = "button";
  stopButton.className = "wm-speech-playback-modal__stop";
  stopButton.dataset.testid = "speech-playback-stop";
  stopButton.dataset.part = "speech-action";
  stopButton.addEventListener("click", () => {
    if (overlay.dataset.state === "pending") {
      closePendingSpeechModal();
      return;
    }
    stopSpeechPlayback();
  });
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (overlay.dataset.state === "pending") {
        closePendingSpeechModal();
        return;
      }
      stopSpeechPlayback();
    }
  });

  panel.append(status, title, stopButton, timeline);
  overlay.append(panel);
  document.body.append(overlay);
  activeSpeechModal = overlay;
  configureSpeechPlaybackModal(overlay, stateName);
  updateSpeechTimeline(activeAudio);
  stopButton.focus({ preventScroll: true });
}

function showSpeechPendingModal(key) {
  if (!key) {
    return;
  }
  activeSpeechPendingKey = key;
  syncSpeechPlaybackModal(key, "pending");
}

function setSpeechButtonPlaying(button, playing, hasSpeech = true) {
  if (!button) {
    return;
  }
  button.dataset.playing = playing ? "true" : "false";
  const playLabel = hasSpeech ? "Play spoken summary" : "Generate spoken summary";
  button.setAttribute("aria-label", playing ? "Stop spoken summary" : playLabel);
  button.title = playing ? "Stop spoken summary" : playLabel;
  button.innerHTML = playing ? STOP_ICON_SVG : PLAY_ICON_SVG;
}

export function updateSpeechButtonPlaybackState(button, key) {
  setSpeechButtonPlaying(
    button,
    Boolean(key && button?.dataset.speechKey === key),
    button?.dataset.hasSpeech === "true",
  );
}

export function getActiveSpeechPlaybackKey() {
  return activeSpeechKey;
}

export function stopSpeechPlayback() {
  stopActiveAudio();
}

function playSpeech(publicPath, key = "") {
  if (!publicPath) {
    return;
  }
  stopActiveAudio();
  const audio = new Audio(publicPath);
  activeAudio = audio;
  dispatchSpeechPlaybackChange(key);
  audio.addEventListener("loadedmetadata", () => updateSpeechTimeline(audio));
  audio.addEventListener("durationchange", () => updateSpeechTimeline(audio));
  audio.addEventListener("timeupdate", () => updateSpeechTimeline(audio));
  audio.addEventListener("ended", () => {
    if (activeAudio === audio) {
      activeAudio = null;
      dispatchSpeechPlaybackChange(null);
    }
  }, { once: true });
  void audio.play().catch(() => {
    if (activeAudio === audio) {
      activeAudio = null;
      dispatchSpeechPlaybackChange(null);
    }
  });
}

async function ensureServerSpeech({
  sessionId,
  message,
  button = null,
  generateIfMissing = true,
  onGenerationStart = null,
}) {
  const existing = getSpeech(message);
  if (existing?.publicPath) {
    return { speech: existing, generated: false };
  }

  const cacheKey = getSpeechCacheKey(sessionId, message);
  if (!cacheKey) {
    throw new Error("Message audio is not available yet");
  }

  const cached = generatedSpeech.get(cacheKey);
  if (cached?.publicPath) {
    return { speech: cached, generated: false };
  }

  const inFlight = speechRequests.get(cacheKey);
  if (inFlight) {
    onGenerationStart?.(cacheKey);
    return inFlight;
  }

  const text = getMessageText(message);
  if (!text) {
    throw new Error("Message has no readable text");
  }

  if (button) {
    button.disabled = true;
    button.dataset.loading = "true";
  }

  const request = (async () => {
    const serverMessage = await resolveServerMessage(sessionId, message);
    if (!serverMessage) {
      throw new Error("Message audio is not available yet");
    }
    const serverSpeech = getSpeech(serverMessage);
    if (serverSpeech?.publicPath) {
      generatedSpeech.set(cacheKey, serverSpeech);
      await MessageStore.updateMessageSpeech(sessionId, serverMessage, serverSpeech);
      return { speech: serverSpeech, generated: false };
    }
    if (!generateIfMissing) {
      throw new Error("Message audio is not available yet");
    }
    onGenerationStart?.(cacheKey);
    const response = await generateMessageSpeechApi({
      sessionId,
      messageId: getMessageId(serverMessage),
      text,
      summary: true,
    });
    const speech = response?.speech ?? null;
    if (!speech?.publicPath) {
      throw new Error("Speech generation returned no audio");
    }
    generatedSpeech.set(cacheKey, speech);
    await MessageStore.updateMessageSpeech(sessionId, serverMessage, speech);
    return { speech, generated: true };
  })();

  speechRequests.set(cacheKey, request);
  try {
    return await request;
  } catch (error) {
    throw error;
  } finally {
    speechRequests.delete(cacheKey);
    if (activeSpeechPendingKey === cacheKey) {
      activeSpeechPendingKey = "";
    }
    if (button) {
      button.disabled = false;
      delete button.dataset.loading;
    }
  }
}

export async function readMessageAloud({ sessionId, message, showToast, button = null }) {
  if (!getMessageText(message)) {
    showToast?.("Message has no readable text", { type: "warning" });
    return;
  }

  try {
    const { speech } = await ensureServerSpeech({
      sessionId,
      message,
      button,
      generateIfMissing: true,
      onGenerationStart: (key) => showSpeechPendingModal(key),
    });
    if (button) {
      button.dataset.hasSpeech = "true";
      updateSpeechButtonPlaybackState(button, getActiveSpeechPlaybackKey());
    }
    const key = getSpeechCacheKey(sessionId, message);
    playSpeech(speech.publicPath, key);
  } catch (error) {
    if (activeSpeechModal?.dataset.state === "pending") {
      closePendingSpeechModal();
    }
    showToast?.(error instanceof Error ? error.message : "Speech is not available in this browser", { type: "error" });
  }
}

export function isSessionSpeechGenerationEnabled(session) {
  return Boolean(session?.metadata?.speechGenerateAudio);
}

export function isSessionAlwaysReadEnabled(session) {
  return isSessionSpeechGenerationEnabled(session) && Boolean(session?.metadata?.speechAlwaysRead);
}

export function attachMessageSpeechButton(bubble, { sessionId, message, showToast }) {
  if (!bubble || bubble.dataset.speechAttached === "true") {
    return;
  }
  if (!isReadableAssistantMessage(message)) {
    return;
  }

  const actions = bubble.querySelector(".wm-message-actions") ?? document.createElement("div");
  actions.className = "wm-message-actions";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "wm-message-speech-play";
  button.dataset.testid = "message-speech-play";
  button.dataset.speechKey = getSpeechCacheKey(sessionId, message);
  button.dataset.hasSpeech = hasMessageSpeech(message) ? "true" : "false";
  setSpeechButtonPlaying(button, false, button.dataset.hasSpeech === "true");
  const playbackListener = (event) => {
    if (!button.isConnected) {
      window.removeEventListener("speech-playback-change", playbackListener);
      return;
    }
    updateSpeechButtonPlaybackState(button, event.detail?.key ?? null);
  };
  window.addEventListener("speech-playback-change", playbackListener);
  updateSpeechButtonPlaybackState(button, getActiveSpeechPlaybackKey());
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (button.dataset.playing === "true") {
      stopSpeechPlayback();
      return;
    }
    void readMessageAloud({ sessionId, message, showToast, button });
  });

  actions.prepend(button);
  if (!actions.parentNode) {
    bubble.append(actions);
  }
  bubble.dataset.speechAttached = "true";
}

export async function ensureLatestAssistantSpeech({ sessionId, session, conversation, showToast }) {
  if (!isSessionSpeechGenerationEnabled(session) || !Array.isArray(conversation) || conversation.length === 0) {
    return null;
  }

  const latest = [...conversation].reverse().find((message) => isAssistantRole(message) && getMessageText(message));
  if (!latest || hasMessageSpeech(latest)) {
    return null;
  }

  try {
    const { speech } = await ensureServerSpeech({
      sessionId,
      message: { ...latest },
      generateIfMissing: true,
    });
    return speech;
  } catch (error) {
    showToast?.(error instanceof Error ? error.message : "Speech generation failed", { type: "error" });
    return null;
  }
}

export async function autoReadLatestAssistantMessage({ sessionId, session, conversation, showToast }) {
  if (!isSessionAlwaysReadEnabled(session) || !Array.isArray(conversation) || conversation.length === 0) {
    return;
  }

  const latest = [...conversation].reverse().find((message) => isAssistantRole(message) && getMessageText(message));
  const cacheKey = latest ? getSpeechCacheKey(sessionId, latest) : "";
  if (!latest || !cacheKey || autoPlayedMessages.has(cacheKey)) {
    return;
  }

  const existingTimer = autoReadTimers.get(cacheKey);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }
  const latestSnapshot = { ...latest };
  const timer = setTimeout(async () => {
    autoReadTimers.delete(cacheKey);
    if (autoPlayedMessages.has(cacheKey) || autoReadingMessages.has(cacheKey)) {
      return;
    }
    autoReadingMessages.add(cacheKey);
    try {
      const { speech, generated } = await ensureServerSpeech({
        sessionId,
        message: latestSnapshot,
        generateIfMissing: true,
      });
      if (generated) {
        playSpeech(speech.publicPath, cacheKey);
      }
      autoPlayedMessages.add(cacheKey);
    } catch (error) {
      showToast?.(error instanceof Error ? error.message : "Speech generation failed", { type: "error" });
    } finally {
      autoReadingMessages.delete(cacheKey);
    }
  }, AUTO_READ_IDLE_MS);
  autoReadTimers.set(cacheKey, timer);
}

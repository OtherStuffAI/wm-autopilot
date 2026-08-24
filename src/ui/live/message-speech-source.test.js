import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const speechSource = readFileSync(new URL("./message-speech.js", import.meta.url), "utf8");
const conversationSource = readFileSync(new URL("./conversation-window.js", import.meta.url), "utf8");
const clipboardSource = readFileSync(new URL("../utils/clipboard.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("live message speech controls", () => {
  test("renders speech playback in the shared message action group", () => {
    expect(conversationSource).toContain("attachCopyButton(bubble);");
    expect(conversationSource).toContain("attachMessageSpeechButton(bubble");
    expect(conversationSource).toContain("function getSpeechSummary(message)");
    expect(conversationSource).toContain('element.className = "wm-message-speech-summary"');
    expect(conversationSource).toContain('element.dataset.testid = "message-speech-summary"');
    expect(clipboardSource).toContain('bubble.querySelector(".wm-message-actions")');
    expect(speechSource).toContain('bubble.querySelector(".wm-message-actions")');
    expect(speechSource).toContain('button.className = "wm-message-speech-play"');
  });

  test("uses the server message id preserved beside the Dexie primary key", () => {
    expect(speechSource).toContain('import { fetchSessionMessagesApi } from "../services/sessions.js";');
    expect(speechSource).toContain("message?.messageId");
    expect(speechSource).toContain("message?.message_id");
    expect(speechSource).toContain("resolveServerMessage(sessionId, message)");
    expect(speechSource).toContain("fetchSessionMessagesApi(sessionId, { refresh: true })");
  });

  test("shows speech controls for readable assistant messages and generates on demand", () => {
    expect(speechSource).toContain("export function hasMessageSpeech(message)");
    expect(speechSource).toContain("function isReadableAssistantMessage(message)");
    expect(speechSource).toContain("!isReadableAssistantMessage(message)");
    expect(speechSource).toContain("generateIfMissing: true");
    expect(speechSource).toContain('button.dataset.hasSpeech = hasMessageSpeech(message) ? "true" : "false"');
    expect(speechSource).toContain('"Generate spoken summary"');
    expect(speechSource).not.toContain("!isAssistantRole(message) || !getMessageText(message) || !hasMessageSpeech(message)");
    expect(speechSource).not.toContain("!isAssistantRole(message) || !getMessageId(message) || !getMessageText(message)");
  });

  test("writes generated audio back to Dexie so playback controls can appear", () => {
    expect(speechSource).toContain('import { MessageStore } from "./db.js";');
    expect(speechSource).toContain("MessageStore.updateMessageSpeech(sessionId, serverMessage, speech)");
    expect(speechSource).toContain("MessageStore.updateMessageSpeech(sessionId, serverMessage, serverSpeech)");
  });

  test("separates generation from auto-read playback", () => {
    expect(speechSource).toContain("export function isSessionSpeechGenerationEnabled(session)");
    expect(speechSource).toContain("export function getLatestAssistantSpeechKey(sessionId, conversation)");
    expect(speechSource).toContain("if (createdAt && text)");
    expect(speechSource).toContain("return messageId ? `${sessionId}:${messageId}` : \"\";");
    expect(speechSource).toContain("return isSessionSpeechGenerationEnabled(session) && Boolean(session?.metadata?.speechAlwaysRead)");
    expect(speechSource).toContain("export async function ensureLatestAssistantSpeech");
    expect(speechSource).toContain("if (generated) {");
    expect(speechSource).toContain("playSpeech(speech.publicPath, cacheKey)");
  });

  test("turns play controls into stop controls while audio is active", () => {
    expect(speechSource).toContain("const STOP_ICON_SVG");
    expect(speechSource).toContain('window.dispatchEvent(new CustomEvent("speech-playback-change"');
    expect(speechSource).toContain('function syncSpeechPlaybackModal(key, stateName = "playing")');
    expect(speechSource).toContain('overlay.className = "wm-speech-playback-modal"');
    expect(speechSource).toContain('overlay.dataset.testid = "speech-playback-modal"');
    expect(speechSource).toContain('stopButton.dataset.testid = "speech-playback-stop"');
    expect(speechSource).toContain("function updateSpeechTimeline(audio = activeAudio)");
    expect(speechSource).toContain("function getSpeechSeekableEnd(audio)");
    expect(speechSource).toContain("const totalTime = Math.max(reportedDuration, seekableEnd, currentTime)");
    expect(speechSource).toContain("scrubber.max = totalTime > 0 ? String(Math.ceil(totalTime)) : \"0\";");
    expect(speechSource).toContain('scrubber.dataset.testid = "speech-playback-scrubber"');
    expect(speechSource).toContain('audio.addEventListener("timeupdate", () => updateSpeechTimeline(audio))');
    expect(speechSource).toContain("activeAudio.currentTime = nextTime");
    expect(speechSource).toContain("export function stopSpeechPlayback()");
    expect(speechSource).toContain("export function getActiveSpeechPlaybackKey()");
    expect(speechSource).toContain("export function updateSpeechButtonPlaybackState(button, key)");
    expect(speechSource).toContain("updateSpeechButtonPlaybackState(button, getActiveSpeechPlaybackKey())");
    expect(speechSource).toContain('button.dataset.playing === "true"');
    expect(speechSource).toContain("stopSpeechPlayback();");
  });

  test("shows a dismissible summarising modal while missing speech is generated", () => {
    expect(speechSource).toContain('title.textContent = isPending ? "Summarising" : "Audio playing";');
    expect(speechSource).toContain('actionButton.textContent = isPending ? "Close" : "Stop";');
    expect(speechSource).toContain('timeline.hidden = isPending;');
    expect(speechSource).toContain("function showSpeechPendingModal(key)");
    expect(speechSource).toContain("onGenerationStart?.(cacheKey)");
    expect(speechSource).toContain("onGenerationStart: (key) => showSpeechPendingModal(key)");
    expect(speechSource).toContain("closePendingSpeechModal();");
    expect(styles).toContain('.wm-speech-playback-modal[data-state="pending"] .wm-speech-playback-modal__stop');
  });

  test("uses server-generated summary audio instead of browser speech for read aloud", () => {
    expect(speechSource).toContain("summary: true");
    expect(speechSource).not.toContain("new SpeechSynthesisUtterance");
    expect(speechSource).not.toContain("readWithBrowserSpeech");
  });

  test("styles message actions as bottom-right icon controls", () => {
    expect(styles).toContain(".wm-message-actions");
    expect(styles).toContain(".wm-message-copy,\n.wm-message-speech-play");
    expect(styles).toContain(".wm-message-speech-summary");
    expect(styles).toContain(".wm-speech-playback-modal");
    expect(styles).toContain(".wm-speech-playback-modal__stop");
    expect(styles).toContain(".wm-speech-playback-modal__timeline");
    expect(styles).toContain(".wm-speech-playback-modal__scrubber");
    expect(styles).toContain("color: #f8fafc;");
    expect(styles).toContain("bottom: 0.65rem;");
    expect(styles).toContain("right: 0.85rem;");
  });
});

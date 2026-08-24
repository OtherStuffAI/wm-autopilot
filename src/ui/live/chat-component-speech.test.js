import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const source = readFileSync(new URL("./chat-component.js", import.meta.url), "utf8");

describe("Alpine chat speech controls", () => {
  test("renders spoken summary playback beside copy controls", () => {
    expect(source).toContain("readMessageAloud");
    expect(source).toContain("autoReadLatestAssistantMessage");
    expect(source).toContain("ensureLatestAssistantSpeech");
    expect(source).toContain("getLatestAssistantSpeechKey");
    expect(source).toContain("getMessageSpeechKey");
    expect(source).toContain("stopSpeechPlayback");
    expect(source).toContain("canReadMessage(message)");
    expect(source).toContain("return isReadableAgentMessage(message);");
    expect(source).toContain('"Generate spoken summary"');
    expect(source).toContain("getSpeechSummary(message)");
    expect(source).toContain('data-testid="message-speech-summary"');
    expect(source).toContain('class="wm-message-actions"');
    expect(source).toContain('class="wm-message-speech-play"');
    expect(source).toContain('data-testid="message-speech-play"');
    expect(source).toContain("$store.chat.playMessageSpeech(message, $el)");
  });

  test("renders Alpine speech playback as a play or stop control", () => {
    expect(source).toContain("speechPlaybackKey");
    expect(source).toContain('window.addEventListener("speech-playback-change"');
    expect(source).toContain("isMessageSpeechPlaying(message)");
    expect(source).toContain("getMessageSpeechLabel(message)");
    expect(source).toContain(":data-playing=\"$store.chat.isMessageSpeechPlaying(message) ? 'true' : 'false'\"");
  });

  test("keeps Alpine speech generation and auto-read wired to session details settings", () => {
    expect(source).toContain("isSessionSpeechGenerationEnabled(session)");
    expect(source).toContain("isSessionAlwaysReadEnabled(session)");
    expect(source).toContain("void ensureLatestAssistantSpeech");
    expect(source).toContain("if (this.isBusy)");
    expect(source).toContain("const wasBusy = this.isBusy");
    expect(source).toContain("if (wasBusy && !this.isBusy)");
    expect(source).toContain("_speechBaselineReady");
    expect(source).toContain("_lastSpeechCandidateKey");
    expect(source).toContain("window.Alpine?.store(\"sessions\")?.items");
  });

  test("syncs server messages on load so existing speech attachments show up", () => {
    expect(source).toContain("fetchSessionMessagesApi,");
    expect(source).toContain('from "../services/sessions.js";');
    expect(source).toContain("void this._syncMessagesFromServer(sessionId)");
    expect(source).toContain("MessageStore.syncFromServerIfChanged(sessionId, payload.messages)");
  });

  test("renders Codex working notes as collapsible assistant-side messages", () => {
    expect(source).toContain("renderWorkingNotesHtml");
    expect(source).toContain('role === "agent-working"');
    expect(source).toContain('if (role === "assistant" || role === "agent" || role.startsWith("agent-")) return "assistant";');
    expect(source).toContain(':class="$store.chat.getMessageClass(message)"');
  });
});

import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const source = readFileSync(new URL("./workspace-sections.js", import.meta.url), "utf8");

describe("speech settings section", () => {
  test("offers OpenRouter and local Kokoro provider defaults", () => {
    expect(source).toContain("const LOCAL_SPEECH_DEFAULTS");
    expect(source).toContain("baseUrl: 'http://127.0.0.1:8880/v1'");
    expect(source).toContain("model: 'kokoro'");
    expect(source).toContain("voice: 'am_onyx'");
    expect(source).toContain("summaryBaseUrl: 'http://127.0.0.1:11434/v1'");
    expect(source).toContain("summaryModel: 'gemma4:e4b'");
    expect(source).toContain("providerSelect.dataset.testid = 'settings-speech-provider'");
    expect(source).toContain("settings-speech-summary-base-url");
    expect(source).toContain("saveUserSetting('speech_summary_base_url', summaryBaseUrl)");
    expect(source).toContain("settings-speech-chat-replies-enabled");
    expect(source).toContain("saveUserSetting('speech_chat_replies_enabled'");
    expect(source).toContain("saveUserSetting('speech_chat_replies_mode'");
    expect(source).toContain("saves.push(saveUserSetting('speech_provider', provider))");
    expect(source).toContain("if (provider === 'local') saves.push(deleteUserSetting('speech_api_key'))");
  });
});

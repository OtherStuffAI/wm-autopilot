import { describe, expect, test } from "bun:test";

import { normalizeSpeechText, resolveAudioSpeechConfig } from "./audio-speech";

describe("audio speech config", () => {
  test("allows local OpenAI-compatible speech without an API key", () => {
    const config = resolveAudioSpeechConfig({
      provider: "local",
      baseUrl: "http://127.0.0.1:8880/v1",
      model: "kokoro",
      voice: "am_onyx",
      format: "mp3",
    });

    expect(config).toMatchObject({
      provider: "local",
      baseUrl: "http://127.0.0.1:8880/v1",
      model: "kokoro",
      voice: "am_onyx",
      format: "mp3",
    });
    expect(config?.apiKey).toBeUndefined();
  });

  test("still requires an API key for remote speech", () => {
    const config = resolveAudioSpeechConfig({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "hexgrad/kokoro-82m",
      voice: "am_onyx",
      format: "mp3",
    });

    expect(config).toBeNull();
  });
});

describe("speech text normalization", () => {
  test("keeps Flight Deck mention labels while removing UUID references", () => {
    const text = normalizeSpeechText(
      "I reopened task @[Update Tower reaction schema for green check emoji](mention:task:e9479065-223b-488d-84c3-6b8824c64226) " +
      "and started software-implementation-review-loop (9818e755-f921-400a-adf9-c934af46f02e).",
    );

    expect(text).toBe(
      "I reopened task Update Tower reaction schema for green check emoji and started software-implementation-review-loop.",
    );
  });

  test("keeps ordinary markdown link text instead of reading the target", () => {
    const text = normalizeSpeechText(
      "See [review notes](https://example.test/notes/9818e755-f921-400a-adf9-c934af46f02e) before continuing.",
    );

    expect(text).toBe("See review notes before continuing.");
  });
});

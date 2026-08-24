import { afterEach, describe, expect, test } from "bun:test";

import { generateMessageSpeechApi } from "./message-speech.js";

describe("message speech service", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("requests summary speech mode when asked", async () => {
    let requestedUrl = "";
    let requestedBody = null;
    globalThis.fetch = async (url, init) => {
      requestedUrl = String(url);
      requestedBody = JSON.parse(String(init.body));
      return Response.json({ speech: { publicPath: "/uploads/files/test.mp3" } });
    };

    await generateMessageSpeechApi({
      sessionId: "session 1",
      messageId: "message 1",
      text: "Full assistant response",
      summary: true,
    });

    expect(requestedUrl).toBe("/api/sessions/session%201/messages/message%201/speech");
    expect(requestedBody).toEqual({
      text: "Full assistant response",
      summary: true,
      mode: "summary",
    });
  });
});

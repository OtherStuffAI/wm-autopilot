import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const source = readFileSync(new URL("./speech-summary.ts", import.meta.url), "utf8");
const routesSource = readFileSync(new URL("./session-api-routes.ts", import.meta.url), "utf8");

describe("speech summary config", () => {
  test("supports local OpenAI-compatible chat summaries without an API key", () => {
    expect(source).toContain("apiKey?: string");
    expect(source).toContain("if (input.config.apiKey?.trim())");
    expect(source).toContain("headers.Authorization");
    expect(routesSource).toContain('const DEFAULT_LOCAL_SPEECH_SUMMARY_BASE_URL = "http://127.0.0.1:11434/v1"');
    expect(routesSource).toContain('const DEFAULT_LOCAL_SPEECH_SUMMARY_MODEL = "gemma4:e4b"');
    expect(routesSource).toContain('settings.speech_provider === "local"');
  });
});

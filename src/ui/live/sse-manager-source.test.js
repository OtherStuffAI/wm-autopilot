import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const source = readFileSync(new URL("./sse-manager.js", import.meta.url), "utf8");

describe("live SSE message delivery", () => {
  test("registers exactly one EventSource message handler", () => {
    expect(source).not.toContain("source.onmessage");
    expect(source.match(/source\.addEventListener\("message"/g)).toHaveLength(1);
  });

  test("routes the single message handler through one IndexedDB upsert", () => {
    const handlerStart = source.indexOf('source.addEventListener("message"');
    const handlerEnd = source.indexOf('source.addEventListener("status"', handlerStart);
    const handler = source.slice(handlerStart, handlerEnd);

    expect(handler.match(/MessageStore\.upsertMessage/g)).toHaveLength(1);
    expect(handler).toContain("notifyMessageListeners(sessionId, data, result)");
  });
});

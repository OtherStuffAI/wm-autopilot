import { afterEach, describe, expect, test } from "bun:test";

import { buildDocsFileDownloadUrl } from "./download-url.js";

const originalWindow = globalThis.window;

afterEach(() => {
  globalThis.window = originalWindow;
});

describe("buildDocsFileDownloadUrl", () => {
  test("builds an inline docs download URL for a file path", () => {
    globalThis.window = { location: { origin: "http://localhost:3600" } };

    expect(buildDocsFileDownloadUrl("/workspace/report.md", { inline: true }))
      .toBe("/api/docs/file/download?path=%2Fworkspace%2Freport.md&inline=1");
  });
});

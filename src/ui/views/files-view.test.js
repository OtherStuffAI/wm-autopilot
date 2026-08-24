import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const source = readFileSync(new URL("./files-view.js", import.meta.url), "utf8");

describe("files-view surface labels", () => {
  test("uses the active files/docs surface for the browser panel title", () => {
    expect(source).toContain("const surfaceCopy = getFilesSurfaceCopy(filesSurface);");
    expect(source).toContain("headerTitle.textContent = surfaceCopy.title;");
    expect(source).not.toContain('headerTitle.textContent = "Files";');
  });
});

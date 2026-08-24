import { describe, expect, test } from "bun:test";

import {
  DOCS_ROUTE_PREFIX,
  buildFilesRouteForWorkspacePath,
  buildFilesPreviewRoutePath,
  getFilesRoutePrefixForPath,
  getFilesSurfaceFromPath,
  rewriteWorkspaceUrlToFilesRoute,
} from "./route-url.js";

describe("buildFilesPreviewRoutePath", () => {
  test("preserves absolute file paths for the Files preview route", () => {
    expect(buildFilesPreviewRoutePath("/Users/example/code/report.md"))
      .toBe("/files/%2FUsers%2Fexample%2Fcode%2Freport.md");
  });

  test("builds a route for a relative file path", () => {
    expect(buildFilesPreviewRoutePath("notes/report.md")).toBe("/files/notes%2Freport.md");
  });

  test("can build Docs preview routes with the shared file browser", () => {
    expect(buildFilesPreviewRoutePath("notes/report.md", { routePrefix: DOCS_ROUTE_PREFIX }))
      .toBe("/docs/notes%2Freport.md");
  });
});

describe("files route surface helpers", () => {
  test("detects Docs paths", () => {
    expect(getFilesSurfaceFromPath("/docs")).toBe("docs");
    expect(getFilesSurfaceFromPath("/docs/guide.md")).toBe("docs");
    expect(getFilesRoutePrefixForPath("/docs/guide.md")).toBe("/docs");
  });

  test("defaults to Files paths", () => {
    expect(getFilesSurfaceFromPath("/files")).toBe("files");
    expect(getFilesSurfaceFromPath("/files/readme.md")).toBe("files");
    expect(getFilesRoutePrefixForPath("/files/readme.md")).toBe("/files");
  });
});

describe("workspace file route mapping", () => {
  test("maps absolute workspace paths to slash-preserving Files routes", () => {
    expect(buildFilesRouteForWorkspacePath("/Users/example/code/app/src/ui/styles.css", {
      defaultDirectory: "/Users/example",
    })).toBe("/files/code/app/src/ui/styles.css");
  });

  test("encodes path segments without encoding route separators", () => {
    expect(buildFilesRouteForWorkspacePath("/workspace/My Project/notes & tasks.md", {
      defaultDirectory: "/workspace",
    })).toBe("/files/My%20Project/notes%20%26%20tasks.md");
  });

  test("does not map paths outside the default workspace directory", () => {
    expect(buildFilesRouteForWorkspacePath("/var/log/system.log", {
      defaultDirectory: "/Users/example",
    })).toBeNull();
  });

  test("rewrites same-origin absolute workspace URLs to Files routes", () => {
    expect(rewriteWorkspaceUrlToFilesRoute(
      "https://agent.example.invalid/Users/example/code/wingmanbefree/autopilot/src/ui/styles.css",
      {
        baseUrl: "https://agent.example.invalid",
        defaultDirectory: "/Users/example",
      },
    )).toBe("/files/code/wingmanbefree/autopilot/src/ui/styles.css");
  });

  test("leaves external URLs unmapped", () => {
    expect(rewriteWorkspaceUrlToFilesRoute("https://example.com/Users/example/code/app.ts", {
      baseUrl: "https://agent.example.invalid",
      defaultDirectory: "/Users/example",
    })).toBeNull();
  });
});

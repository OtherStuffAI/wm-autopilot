import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { randomUUID } from "node:crypto";

import { handleDocsApi, type DocsApiContext } from "./docs-routes";
import type { RequestAuthContext } from "../auth/request-context";
import type { WorkspaceScope } from "../workspaces/workspace-scope";

const authContext: RequestAuthContext = {
  npub: "npub1viewer",
  actorNpub: "npub1viewer",
  session: null,
  delegatedByBot: false,
};

function createDocsApiContext(rootDir: string): DocsApiContext {
  const scope: WorkspaceScope = {
    allowedDirectories: [rootDir],
    defaultDirectory: rootDir,
    aliasDirectory: null,
    docsRoot: rootDir,
    docsRootBoundary: rootDir.endsWith(sep) ? rootDir : `${rootDir}${sep}`,
    isAdmin: false,
  };

  return {
    resolveWorkspace: () => scope,
    ensureApiAccess: async () => null,
    AccessActions: {
      FilesRead: "files:read" as any,
      FilesWrite: "files:write" as any,
    },
    ensureDirectory: async () => rootDir,
    createGitWorktree: async () => ({ branch: "main", path: rootDir, repository: null }),
    executeGitCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    describeGitRepository: async () => null,
  };
}

async function callDocsApi(ctx: DocsApiContext, path: string) {
  const url = new URL(`http://localhost${path}`);
  const request = new Request(url.toString(), { method: "GET" });
  return handleDocsApi(request, url, "GET", authContext, ctx);
}

async function mutateDocsApi(ctx: DocsApiContext, path: string, method: "POST" | "PUT" | "DELETE", body: unknown) {
  const url = new URL(`http://localhost${path}`);
  const request = new Request(url.toString(), {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleDocsApi(request, url, method, authContext, ctx);
}

describe("handleDocsApi file images", () => {
  let rootDir: string;
  let ctx: DocsApiContext;
  const extraPaths: string[] = [];

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), `wingmen-docs-routes-${randomUUID()}-`));
    ctx = createDocsApiContext(rootDir);
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
    await Promise.all(extraPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  test("previews image files without the text preview size limit", async () => {
    const imagePath = join(rootDir, "large.png");
    const bytes = new Uint8Array(3 * 1024 * 1024);
    await writeFile(imagePath, bytes);

    const response = await callDocsApi(ctx, "/api/docs/file?path=large.png");
    const body = await response!.json() as {
      content: string | null;
      format: string;
      label: string;
      mimeType: string;
      size: number;
    };

    expect(response!.status).toBe(200);
    expect(body.content).toBeNull();
    expect(body.format).toBe("image");
    expect(body.label).toBe("Image");
    expect(body.mimeType).toBe("image/png");
    expect(body.size).toBe(bytes.length);
  });

  test("downloads large images as streamed file responses", async () => {
    const imagePath = join(rootDir, "large.png");
    const bytes = new Uint8Array(3 * 1024 * 1024);
    bytes[0] = 137;
    bytes[1] = 80;
    bytes[2] = 78;
    bytes[3] = 71;
    await writeFile(imagePath, bytes);

    const response = await callDocsApi(ctx, "/api/docs/file/download?path=large.png");
    const downloaded = await response!.arrayBuffer();

    expect(response!.status).toBe(200);
    expect(response!.headers.get("content-disposition")).toBe('attachment; filename="large.png"');
    expect(response!.headers.get("content-type")).toBe("image/png");
    expect(response!.headers.get("content-length")).toBe(String(bytes.length));
    expect(downloaded.byteLength).toBe(bytes.length);
  });

  test("marks json, csv, and pdf files as previewable formats", async () => {
    await writeFile(join(rootDir, "data.json"), '{"name":"Ada","skills":["math"]}');
    await writeFile(join(rootDir, "people.csv"), "name,count\nAda,2\nGrace,3");
    await writeFile(join(rootDir, "paper.pdf"), "%PDF-1.7\n");

    const response = await callDocsApi(ctx, "/api/docs/tree");
    const body = await response!.json() as {
      entries: Array<{ name: string; previewable: boolean; previewFormat: string; previewLabel: string }>;
    };
    const entries = new Map(body.entries.map((entry) => [entry.name, entry]));

    expect(response!.status).toBe(200);
    expect(entries.get("data.json")).toMatchObject({
      previewable: true,
      previewFormat: "json",
      previewLabel: "JSON",
    });
    expect(entries.get("people.csv")).toMatchObject({
      previewable: true,
      previewFormat: "csv",
      previewLabel: "CSV",
    });
    expect(entries.get("paper.pdf")).toMatchObject({
      previewable: true,
      previewFormat: "pdf",
      previewLabel: "PDF",
    });
  });

  test("labels the shared files root as Workspace", async () => {
    await writeFile(join(rootDir, "note.md"), "# Note\n");

    const response = await callDocsApi(ctx, "/api/docs/tree");
    const body = await response!.json() as {
      displayPath: string;
      entries: Array<{ name: string; displayPath: string }>;
    };

    expect(response!.status).toBe(200);
    expect(body.displayPath).toBe("Workspace");
    expect(body.entries.find((entry) => entry.name === "note.md")?.displayPath).toBe("Workspace/note.md");
  });

  test("loads pdf preview metadata without reading file content", async () => {
    const pdfContent = "%PDF-1.7\n";
    await writeFile(join(rootDir, "paper.pdf"), pdfContent);

    const response = await callDocsApi(ctx, "/api/docs/file?path=paper.pdf");
    const body = await response!.json() as {
      content: string | null;
      format: string;
      mimeType: string;
      size: number;
    };

    expect(response!.status).toBe(200);
    expect(body.content).toBeNull();
    expect(body.format).toBe("pdf");
    expect(body.mimeType).toBe("application/pdf");
    expect(body.size).toBe(pdfContent.length);
  });

  test("rejects outside file symlinks for every docs file operation", async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), `wingmen-docs-outside-${randomUUID()}-`));
    extraPaths.push(outsideDir);
    const outsideFile = join(outsideDir, "secret.md");
    await writeFile(outsideFile, "outside");
    await symlink(outsideFile, join(rootDir, "linked.md"));

    const responses = [
      await callDocsApi(ctx, "/api/docs/file?path=linked.md"),
      await callDocsApi(ctx, "/api/docs/file/raw?path=linked.md"),
      await callDocsApi(ctx, "/api/docs/file/download?path=linked.md"),
      await mutateDocsApi(ctx, "/api/docs/file", "PUT", { path: "linked.md", base64: Buffer.from("changed").toString("base64") }),
      await mutateDocsApi(ctx, "/api/docs/file", "DELETE", { path: "linked.md" }),
      await mutateDocsApi(ctx, "/api/docs/file/copy", "POST", { path: "linked.md", targetDirectory: ".", name: "copy.md" }),
      await mutateDocsApi(ctx, "/api/docs/file/move", "POST", { path: "linked.md", targetDirectory: ".", name: "moved.md" }),
    ];

    expect(responses.map((response) => response?.status)).toEqual([400, 400, 400, 400, 400, 400, 400]);
    expect(await readFile(outsideFile, "utf8")).toBe("outside");
  });

  test("rejects outside, broken, and final directory symlinks", async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), `wingmen-docs-outside-${randomUUID()}-`));
    extraPaths.push(outsideDir);
    await writeFile(join(outsideDir, "secret.md"), "outside");
    await symlink(outsideDir, join(rootDir, "outside-link"));
    await symlink(join(outsideDir, "missing"), join(rootDir, "broken-link"));
    await mkdir(join(rootDir, "safe"));

    const responses = [
      await callDocsApi(ctx, "/api/docs/tree?path=outside-link"),
      await callDocsApi(ctx, "/api/docs/file?path=outside-link/secret.md"),
      await callDocsApi(ctx, "/api/docs/tree?path=broken-link"),
      await mutateDocsApi(ctx, "/api/docs/file", "POST", { directory: "outside-link", name: "created.md", content: "bad" }),
      await mutateDocsApi(ctx, "/api/docs/directory", "POST", { parent: "outside-link", name: "created" }),
    ];
    expect(responses.map((response) => response?.status)).toEqual([400, 400, 400, 400, 400]);
  });

  test("preserves contained Unicode and normalized paths", async () => {
    await mkdir(join(rootDir, "資料"));
    const created = await mutateDocsApi(ctx, "/api/docs/file", "POST", {
      directory: "資料/../資料",
      name: "計画.md",
      content: "安全",
    });
    expect(created?.status).toBe(201);
    const loaded = await callDocsApi(ctx, `/api/docs/file?path=${encodeURIComponent("資料/計画.md")}`);
    expect(loaded?.status).toBe(200);
    await expect(loaded!.json()).resolves.toMatchObject({ name: "計画.md", content: "安全" });
  });
});

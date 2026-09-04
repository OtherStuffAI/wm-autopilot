import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize, sep } from "node:path";
import { gunzipSync } from "node:zlib";

import { afterEach, describe, expect, test } from "bun:test";

import { createProjectStaticAssetService, createStaticAssetService } from "./static-assets";
import { createStaticRouteHandler } from "./static-routes";

const tempRoots: string[] = [];

const withBoundary = (path: string) => path.endsWith(sep) ? path : `${path}${sep}`;

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wingman-static-routes-"));
  tempRoots.push(root);
  return root;
}

async function createHandler(publicFiles: Record<string, string> = {}) {
  const root = await createTempRoot();
  const publicRoot = join(root, "public");
  const aceRoot = join(root, "ace-builds");
  await mkdir(publicRoot, { recursive: true });
  await mkdir(aceRoot, { recursive: true });

  for (const [relativePath, contents] of Object.entries(publicFiles)) {
    const target = join(publicRoot, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }

  const assetService = createStaticAssetService({
    publicRoot: normalize(publicRoot),
    publicRootBoundary: withBoundary(normalize(publicRoot)),
    aceRoot: normalize(aceRoot),
    aceRootBoundary: withBoundary(normalize(aceRoot)),
    vendorPackages: {},
  });

  return createStaticRouteHandler({ assetService, assetVersion: "test" });
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("createStaticRouteHandler", () => {
  test("serves the browser secp256k1 signing module from noble curves v2", async () => {
    const assetService = createProjectStaticAssetService(process.cwd());
    const response = await assetService.serveVendorModule("/vendor/@noble/curves/secp256k1.js");

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    const source = new TextDecoder().decode(gunzipSync(await response!.arrayBuffer()));
    expect(source).toContain("secp256k1");
  });

  test("serves UI JavaScript modules with application/javascript", async () => {
    const handler = await createHandler();
    const request = new Request("http://localhost/app.js");
    const response = await handler.serveBeforeApi(request, "/app.js");

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    expect(response?.headers.get("cache-control")).toBe("no-cache");

    const dispatchRequest = new Request("http://localhost/fd-dispatch/view.js");
    const dispatchResponse = await handler.serveBeforeApi(dispatchRequest, "/fd-dispatch/view.js");
    expect(dispatchResponse?.status).toBe(200);
    expect(dispatchResponse?.headers.get("content-type")).toBe("application/javascript; charset=utf-8");

    for (const pathname of [
      "/apps/lifecycle-command.js",
      "/core/attachment-upload-flows.js",
      "/core/image-upload-request.js",
      "/live/composer-upload-state.js",
      "/live/conversation-queue.js",
      "/live/permission-actions.js",
      "/live/session-ui-reconciliation.js",
      "/live/working-notes-display.js",
      "/scheduler/form-support.js",
      "/sessions/actions-core.js",
      "/sessions/session-attention.js",
      "/sessions/session-tab-state.js",
      "/views/settings/restart-settings-section.js",
      "/views/settings/signing-policies-section.js",
      "/services/signing-policies.js",
      "/views/settings/agent-profile-media-picker.js",
    ]) {
      const moduleResponse = await handler.serveBeforeApi(new Request(`http://localhost${pathname}`), pathname);
      expect(moduleResponse?.status).toBe(200);
      expect(moduleResponse?.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    }
  });

  test("serves public CSS assets with text/css", async () => {
    const handler = await createHandler({
      "theme.css": "body { color: black; }",
    });
    const request = new Request("http://localhost/theme.css");
    const response = await handler.serveAfterApi(request, "/theme.css");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/css;charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  test("does not serve a standalone FD Dispatch SPA route", async () => {
    const handler = await createHandler();
    const request = new Request("http://localhost/fd-dispatch");
    const response = await handler.serveBeforeApi(request, "/fd-dispatch");
    expect(response).toBeUndefined();
  });

  test("serves SPA fallback HTML for Home", async () => {
    const handler = await createHandler();
    const request = new Request("http://localhost/home");
    const response = await handler.serveBeforeApi(request, "/home");
    const html = await response?.text();

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(html).toContain('href="/styles.css?v=test"');
    expect(html).toContain('src="/app.js?v=test"');
    expect(html).not.toContain('data-route="fd-dispatch"');
  });

  test("returns 404 for missing static files", async () => {
    const handler = await createHandler();
    const request = new Request("http://localhost/missing.js");
    const response = await handler.serveAfterApi(request, "/missing.js");

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  });
});

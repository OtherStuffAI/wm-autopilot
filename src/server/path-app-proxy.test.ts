import { describe, expect, mock, test } from "bun:test";

import type { AppWebSocketUpgradeServer } from "./app-websocket-proxy";
import { handlePathBasedAppRequest, type PathAppProxyDependencies } from "./path-app-proxy";

const requestServer: AppWebSocketUpgradeServer = {
  upgrade: () => false,
};

describe("path-based managed app proxy", () => {
  test("canonicalises an app root before resolving its runtime", async () => {
    const resolveAlias = mock(async () => ({
      success: true as const,
      appId: "artifact",
      port: 3701,
    }));
    const proxyRequest = mock(async () => new Response("unexpected"));

    const response = await handlePathBasedAppRequest(
      new Request("https://rick.example/host/artifact?view=board"),
      "/host/artifact",
      requestServer,
      { resolveAlias, proxyRequest },
    );

    expect(response?.status).toBe(302);
    expect(response?.headers.get("Location"))
      .toBe("https://rick.example/host/artifact/?view=board");
    expect(resolveAlias).not.toHaveBeenCalled();
    expect(proxyRequest).not.toHaveBeenCalled();
  });

  test("removes the public app prefix before proxying", async () => {
    const resolveAlias = mock(async () => ({
      success: true as const,
      appId: "artifact",
      port: 3701,
    }));
    const proxyRequest = mock(async (request: Request, targetPort: number) => Response.json({
      targetPort,
      pathname: new URL(request.url).pathname,
      search: new URL(request.url).search,
    }));
    const dependencies: PathAppProxyDependencies = { resolveAlias, proxyRequest };

    const response = await handlePathBasedAppRequest(
      new Request("https://rick.example/host/artifact/artifact-frame/board/index.html?v=4"),
      "/host/artifact/artifact-frame/board/index.html",
      requestServer,
      dependencies,
    );

    expect(resolveAlias).toHaveBeenCalledWith("artifact");
    expect(await response?.json()).toEqual({
      targetPort: 3701,
      pathname: "/artifact-frame/board/index.html",
      search: "?v=4",
    });
  });
});

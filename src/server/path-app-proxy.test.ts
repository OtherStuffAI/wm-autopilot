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
  test("preserves authenticated upgrade headers and query after stripping the app prefix", async () => {
    let captured: unknown;
    const response = await handlePathBasedAppRequest(
      new Request("https://host.example.test/host/app/api/v1/events?workshopId=own&cursor=a%2Fb", {
        headers: { upgrade: "websocket", origin: "https://host.example.test", cookie: "app_session=generic", "sec-websocket-protocol": "events" },
      }),
      "/host/app/api/v1/events",
      { upgrade: (_request, options) => { captured = options.data; return true; } },
      {
        resolveAlias: async () => ({ success: true, appId: "app", port: 4123 }),
        proxyRequest: async () => { throw new Error("HTTP proxy must not handle upgrades"); },
      },
    );
    expect(response).toBeNull();
    expect(captured).toMatchObject({
      targetUrl: "ws://127.0.0.1:4123/api/v1/events?workshopId=own&cursor=a%2Fb",
      originHeader: "https://host.example.test",
      cookieHeader: "app_session=generic",
      protocols: ["events"],
    });
  });

});

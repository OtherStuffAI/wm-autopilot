import { describe, expect, test } from "bun:test";

import {
  buildAppWebSocketOptions,
  buildAppWebSocketTargetUrl,
  createAppWebSocketProxyHandler,
  handleAppWebSocketUpgrade,
  type AppProxyWebSocketData,
} from "./app-websocket-proxy";

describe("app websocket proxy", () => {
  test("builds upstream ws target from rewritten request URL", () => {
    const request = new Request("https://brandname.com/socket?token=abc");
    expect(buildAppWebSocketTargetUrl(request, 4123)).toBe("ws://127.0.0.1:4123/socket?token=abc");
  });

  test("passes target URL, requested protocols, and authentication cookie into Bun upgrade data", () => {
    let captured: unknown;
    const request = new Request("https://brandname.com/socket", {
      headers: {
        cookie: "levelup_session=opaque-token",
        authorization: "Bearer must-not-forward",
        "sec-websocket-protocol": "chat, superchat",
      },
    });
    const response = handleAppWebSocketUpgrade(request, 4123, {
      upgrade: (_request, options) => {
        captured = options.data;
        return true;
      },
    });

    expect(response).toBeUndefined();
    expect(captured).toMatchObject({
      kind: "app-proxy",
      targetUrl: "ws://127.0.0.1:4123/socket",
      protocols: ["chat", "superchat"],
      cookieHeader: "levelup_session=opaque-token",
      upstreamOpen: false,
      queue: [],
    });
  });

  test("builds a narrowly scoped authenticated upstream handshake", () => {
    expect(buildAppWebSocketOptions({
      protocols: ["chat", "superchat"],
      cookieHeader: "levelup_session=opaque-token",
    })).toEqual({
      protocols: ["chat", "superchat"],
      headers: { cookie: "levelup_session=opaque-token" },
    });

    expect(buildAppWebSocketOptions({ protocols: [], cookieHeader: null })).toEqual({});
  });

  test("carries the browser cookie through a real proxy connection", async () => {
    let upstreamCookie: string | null = null;
    const upstream = Bun.serve<{ authenticated: true }>({
      port: 0,
      fetch(request, server) {
        upstreamCookie = request.headers.get("cookie");
        if (upstreamCookie !== "levelup_session=opaque-token") {
          return new Response("unauthenticated", { status: 401 });
        }
        return server.upgrade(request, { data: { authenticated: true } })
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        open(socket) {
          socket.send("authenticated");
        },
        message() {},
      },
    });
    const handler = createAppWebSocketProxyHandler();
    const proxy = Bun.serve<AppProxyWebSocketData>({
      port: 0,
      fetch(request, server) {
        return handleAppWebSocketUpgrade(request, upstream.port, server);
      },
      websocket: handler,
    });
    const ClientWebSocket = WebSocket as unknown as new (
      url: string | URL,
      options?: Bun.WebSocketOptions,
    ) => WebSocket;
    const client = new ClientWebSocket(proxy.url, {
      headers: { cookie: "levelup_session=opaque-token" },
    });

    try {
      const message = await Promise.race([
        new Promise<string>((resolve, reject) => {
          client.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
          client.addEventListener("error", () => reject(new Error("proxy client failed")), { once: true });
        }),
        Bun.sleep(2_000).then(() => { throw new Error("proxy test timed out"); }),
      ]);
      expect(message).toBe("authenticated");
      expect(upstreamCookie).toBe("levelup_session=opaque-token");
    } finally {
      client.close();
      proxy.stop(true);
      upstream.stop(true);
    }
  });
});

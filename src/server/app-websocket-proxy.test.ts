import { describe, expect, test } from "bun:test";

import { buildAppWebSocketTargetUrl, handleAppWebSocketUpgrade } from "./app-websocket-proxy";

describe("app websocket proxy", () => {
  test("builds upstream ws target from rewritten request URL", () => {
    const request = new Request("https://brandname.com/socket?token=abc");
    expect(buildAppWebSocketTargetUrl(request, 4123)).toBe("ws://127.0.0.1:4123/socket?token=abc");
  });

  test("passes target URL and requested protocols into Bun upgrade data", () => {
    let captured: unknown;
    const request = new Request("https://brandname.com/socket", {
      headers: {
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
      upstreamOpen: false,
      queue: [],
    });
  });
});

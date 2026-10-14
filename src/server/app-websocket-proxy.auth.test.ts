import { describe, expect, test } from "bun:test";
import { createAppWebSocketProxyHandler, handleAppWebSocketUpgrade, type AppProxyWebSocketData } from "./app-websocket-proxy";

const publicOrigin = "https://app.example.test";
const cookie = "app_session=generic-test-session";

// Generic app boundary: origin/session/workshop at upgrade, ownership at subscription.
describe("authenticated managed app upgrades", () => {
  test.each([
    { label: "owned subscription", origin: publicOrigin, cookie, workshop: "own", project: "own", result: "request", status: 101 },
    { label: "wrong origin", origin: "https://other.example.test", cookie, workshop: "own", project: "own", result: 1011, status: 403 },
    { label: "missing origin", origin: null, cookie, workshop: "own", project: "own", result: 1011, status: 403 },
    { label: "anonymous", origin: publicOrigin, cookie: null, workshop: "own", project: "own", result: 1011, status: 401 },
    { label: "invalid session", origin: publicOrigin, cookie: "app_session=invalid", workshop: "own", project: "own", result: 1011, status: 401 },
    { label: "wrong workshop", origin: publicOrigin, cookie, workshop: "other", project: "own", result: 1011, status: 404 },
    { label: "wrong project/request pair", origin: publicOrigin, cookie, workshop: "own", project: "other", result: 1008, status: 101 },
  ])("preserves $label boundary", async (scenario) => {
    let handshakeStatus = 0;
    let handshake: { path: string; search: string; origin: string | null; cookie: string | null; host: string | null; authorization: string | null; protocols: string | null } | undefined;
    const upstream = Bun.serve<{ workshop: string }>({
      port: 0,
      fetch(request, server) {
        const url = new URL(request.url);
        handshake = { path: url.pathname, search: url.search, origin: request.headers.get("origin"), cookie: request.headers.get("cookie"), host: request.headers.get("host"), authorization: request.headers.get("authorization"), protocols: request.headers.get("sec-websocket-protocol") };
        handshakeStatus = handshake.origin !== publicOrigin ? 403 : handshake.cookie !== cookie ? 401 : url.searchParams.get("workshopId") !== "own" ? 404 : 101;
        if (handshakeStatus !== 101) return new Response("Upgrade denied", { status: handshakeStatus });
        return server.upgrade(request, { data: { workshop: "own" } }) ? undefined : new Response("Upgrade failed", { status: 400 });
      },
      websocket: {
        message(socket, message) {
          const subscription = JSON.parse(String(message));
          if (subscription.projectId !== "own" || subscription.requestId !== "owned-request") {
            socket.close(1008, "Request subscription unavailable");
            return;
          }
          socket.send(JSON.stringify({ type: "request", requestId: subscription.requestId }));
        },
      },
    });
    const proxy = Bun.serve<AppProxyWebSocketData>({
      port: 0,
      fetch: (request, server) => handleAppWebSocketUpgrade(request, upstream.port, server),
      websocket: createAppWebSocketProxyHandler(),
    });
    const headers: Record<string, string> = { authorization: "Bearer must-not-forward" };
    if (scenario.origin) headers.origin = scenario.origin;
    if (scenario.cookie) headers.cookie = scenario.cookie;
    const client = new WebSocket(`ws://127.0.0.1:${proxy.port}/api/v1/events?workshopId=${scenario.workshop}&cursor=a%2Fb`, { headers, protocols: ["events"] });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await new Promise<string | number>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Upgrade test timed out")), 2000);
        client.addEventListener("open", () => client.send(JSON.stringify({ projectId: scenario.project, requestId: "owned-request" })));
        client.addEventListener("message", event => resolve(JSON.parse(String(event.data)).type));
        client.addEventListener("close", event => resolve(event.code));
        client.addEventListener("error", () => reject(new Error("Client upgrade failed")));
      });
      expect(result).toBe(scenario.result);
      expect(handshakeStatus).toBe(scenario.status);
      expect(handshake).toEqual({ path: "/api/v1/events", search: `?workshopId=${scenario.workshop}&cursor=a%2Fb`, origin: scenario.origin, cookie: scenario.cookie, host: `127.0.0.1:${upstream.port}`, authorization: null, protocols: "events" });
    } finally {
      clearTimeout(timer);
      client.close();
      proxy.stop(true);
      upstream.stop(true);
    }
  });
});

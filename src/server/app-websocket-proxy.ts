import type { ServerWebSocket } from "bun";

export interface AppProxyWebSocketData {
  kind: "app-proxy";
  targetUrl: string;
  protocols: string[];
  upstream?: WebSocket;
  upstreamOpen: boolean;
  queue: Array<string | Buffer>;
}

export interface AppWebSocketUpgradeServer {
  upgrade: (request: Request, options: { data: AppProxyWebSocketData }) => boolean;
}

function parseWebSocketProtocols(request: Request): string[] {
  return (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((protocol) => protocol.trim())
    .filter((protocol) => protocol.length > 0);
}

export function buildAppWebSocketTargetUrl(request: Request, targetPort: number): string {
  const url = new URL(request.url);
  return `ws://127.0.0.1:${targetPort}${url.pathname}${url.search}`;
}

export function handleAppWebSocketUpgrade(
  request: Request,
  targetPort: number,
  server: AppWebSocketUpgradeServer,
): Response | undefined {
  const targetUrl = buildAppWebSocketTargetUrl(request, targetPort);
  const upgraded = server.upgrade(request, {
    data: {
      kind: "app-proxy",
      targetUrl,
      protocols: parseWebSocketProtocols(request),
      upstreamOpen: false,
      queue: [],
    },
  });
  if (upgraded) {
    return undefined;
  }
  return Response.json({ error: "WebSocket upgrade failed" }, { status: 400 });
}

export function createAppWebSocketProxyHandler() {
  const closePair = (
    ws: ServerWebSocket<AppProxyWebSocketData>,
    code = 1000,
    reason = "",
  ) => {
    try {
      ws.data.upstream?.close(code, reason);
    } catch {
      // Ignore close races between client and upstream.
    }
    try {
      ws.close(code, reason);
    } catch {
      // Ignore close races between client and upstream.
    }
  };

  const sendToClient = (ws: ServerWebSocket<AppProxyWebSocketData>, data: unknown) => {
    if (typeof data === "string") {
      ws.sendText(data);
      return;
    }
    if (data instanceof ArrayBuffer) {
      ws.send(data);
      return;
    }
    if (ArrayBuffer.isView(data)) {
      const copy = new Uint8Array(data.byteLength);
      copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      ws.send(copy.buffer);
      return;
    }
    if (data instanceof Blob) {
      data.arrayBuffer()
        .then((buffer) => ws.send(buffer))
        .catch(() => closePair(ws, 1011, "Failed to proxy WebSocket message"));
    }
  };

  return {
    open(ws: ServerWebSocket<AppProxyWebSocketData>) {
      if (ws.data?.kind !== "app-proxy") return;

      const upstream = ws.data.protocols.length > 0
        ? new WebSocket(ws.data.targetUrl, ws.data.protocols)
        : new WebSocket(ws.data.targetUrl);
      upstream.binaryType = "arraybuffer";
      ws.data.upstream = upstream;

      upstream.addEventListener("open", () => {
        ws.data.upstreamOpen = true;
        const queued = ws.data.queue.splice(0);
        for (const message of queued) {
          upstream.send(message);
        }
      });
      upstream.addEventListener("message", (event) => {
        sendToClient(ws, event.data);
      });
      upstream.addEventListener("close", (event) => {
        closePair(ws, event.code || 1000, event.reason || "");
      });
      upstream.addEventListener("error", () => {
        closePair(ws, 1011, "Upstream WebSocket error");
      });
    },

    message(ws: ServerWebSocket<AppProxyWebSocketData>, message: string | Buffer) {
      if (ws.data?.kind !== "app-proxy") return;
      const upstream = ws.data.upstream;
      if (ws.data.upstreamOpen && upstream?.readyState === WebSocket.OPEN) {
        upstream.send(message);
        return;
      }
      ws.data.queue.push(message);
    },

    close(ws: ServerWebSocket<AppProxyWebSocketData>) {
      if (ws.data?.kind !== "app-proxy") return;
      try {
        ws.data.upstream?.close();
      } catch {
        // Ignore close races between client and upstream.
      }
    },
  };
}

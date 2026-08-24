import type { ServerWebSocket } from "bun";

import {
  createAppWebSocketProxyHandler,
  type AppProxyWebSocketData,
} from "./app-websocket-proxy";
import {
  createTerminalWebSocketHandler,
  type TerminalWebSocketContext,
  type TerminalWebSocketData,
} from "./terminal-websocket";

export type WingmanWebSocketData = TerminalWebSocketData | AppProxyWebSocketData;

export function createWingmanWebSocketHandler(ctx: TerminalWebSocketContext) {
  const terminal = createTerminalWebSocketHandler(ctx);
  const appProxy = createAppWebSocketProxyHandler();

  return {
    open(ws: ServerWebSocket<WingmanWebSocketData>) {
      if (ws.data?.kind === "app-proxy") {
        appProxy.open(ws as ServerWebSocket<AppProxyWebSocketData>);
      }
    },

    message(ws: ServerWebSocket<WingmanWebSocketData>, message: string | Buffer) {
      if (ws.data?.kind === "terminal") {
        return terminal.message(ws as ServerWebSocket<TerminalWebSocketData>, message);
      }
      if (ws.data?.kind === "app-proxy") {
        return appProxy.message(ws as ServerWebSocket<AppProxyWebSocketData>, message);
      }
    },

    close(ws: ServerWebSocket<WingmanWebSocketData>) {
      if (ws.data?.kind === "terminal") {
        return terminal.close(ws as ServerWebSocket<TerminalWebSocketData>);
      }
      if (ws.data?.kind === "app-proxy") {
        return appProxy.close(ws as ServerWebSocket<AppProxyWebSocketData>);
      }
    },
  };
}

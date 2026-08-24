import type { ServerWebSocket } from "bun";
import type { RequestAuthContext } from "../auth/request-context";
import { getEffectiveOwnerNpub } from "../auth/effective-owner";
import type { TerminalSessionManager } from "../terminal/terminal-session-manager";
import type { TerminalTicketStore } from "../terminal/terminal-ticket-store";
import type { TerminalPinService } from "../terminal/terminal-pin-service";

export interface TerminalWebSocketData {
  kind: "terminal";
  connectionId: string;
  npub: string;
}

export interface TerminalWebSocketContext {
  tickets: TerminalTicketStore;
  sessions: TerminalSessionManager;
  pinService: TerminalPinService;
  isAdminNpub: (npub: string | null | undefined) => boolean;
}

export interface TerminalWebSocketUpgradeServer {
  upgrade: (request: Request, options: { data: TerminalWebSocketData }) => boolean;
}

export async function handleTerminalWebSocketUpgrade(
  request: Request,
  url: URL,
  authContext: RequestAuthContext,
  server: TerminalWebSocketUpgradeServer,
  ctx: TerminalWebSocketContext,
): Promise<Response | null | undefined> {
  if (url.pathname !== "/api/terminal/ws") {
    return null;
  }

  const npub = getEffectiveOwnerNpub(authContext);
  if (!authContext.session || !npub || !ctx.isAdminNpub(npub)) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  if (!ctx.pinService.isConfigured()) {
    return Response.json({ error: "Terminal is not configured" }, { status: 503 });
  }

  const ticket = url.searchParams.get("ticket");
  if (!ctx.tickets.consume(ticket, npub)) {
    return Response.json({ error: "Invalid terminal ticket" }, { status: 403 });
  }

  const upgraded = server.upgrade(request, {
    data: {
      kind: "terminal",
      connectionId: crypto.randomUUID(),
      npub,
    },
  });
  if (upgraded) {
    return undefined;
  }
  return Response.json({ error: "WebSocket upgrade failed" }, { status: 400 });
}

export function createTerminalWebSocketHandler(ctx: TerminalWebSocketContext) {
  const sendError = (ws: ServerWebSocket<TerminalWebSocketData>, message: string) => {
    ws.sendText(JSON.stringify({ type: "error", message }));
  };

  return {
    async message(ws: ServerWebSocket<TerminalWebSocketData>, message: string | Buffer) {
      if (ws.data?.kind !== "terminal") return;
      let payload: unknown;
      try {
        payload = JSON.parse(typeof message === "string" ? message : message.toString("utf8"));
      } catch {
        sendError(ws, "Invalid terminal message");
        return;
      }
      if (!payload || typeof payload !== "object") return;
      const record = payload as Record<string, unknown>;
      if (record.type === "start") {
        try {
          await ctx.sessions.start(ws.data.connectionId, ws, {
            cols: typeof record.cols === "number" ? record.cols : undefined,
            rows: typeof record.rows === "number" ? record.rows : undefined,
          });
          ws.sendText(JSON.stringify({ type: "ready" }));
        } catch (error) {
          sendError(ws, error instanceof Error ? error.message : String(error));
        }
        return;
      }
      if (record.type === "input") {
        ctx.sessions.write(ws.data.connectionId, record.data);
        return;
      }
      if (record.type === "resize") {
        ctx.sessions.resize(ws.data.connectionId, record.cols, record.rows);
      }
    },
    close(ws: ServerWebSocket<TerminalWebSocketData>) {
      if (ws.data?.kind === "terminal") {
        ctx.sessions.close(ws.data.connectionId);
      }
    },
  };
}

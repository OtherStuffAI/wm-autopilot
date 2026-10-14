import type { ServerWebSocket } from "bun";
import { hasTerminalOrigin } from "../terminal/terminal-origin";
import type { RequestAuthContext } from "../auth/request-context";
import { getEffectiveOwnerNpub } from "../auth/effective-owner";
import type { TerminalSessionManager } from "../terminal/terminal-session-manager";
import type { TerminalTicketStore } from "../terminal/terminal-ticket-store";
import type { TerminalPinService } from "../terminal/terminal-pin-service";

export interface TerminalWebSocketData {
  kind: "terminal";
  connectionId: string;
  npub: string;
  state?: "starting" | "ready" | "closed";
}

export interface TerminalWebSocketContext {
  publicOrigin: string;
  reportFailure?: (phase: string, reason: string) => void;
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

  const reject = (status: number, error: string) => {
    ctx.reportFailure?.("upgrade", error);
    return Response.json({ error, phase: "upgrade" }, { status });
  };
  if (!hasTerminalOrigin(request, ctx.publicOrigin)) {
    return reject(403, "Terminal origin rejected");
  }

  const npub = getEffectiveOwnerNpub(authContext);
  if (!authContext.session || !npub || !ctx.isAdminNpub(npub)) {
    return reject(401, "Authentication required");
  }

  if (!ctx.pinService.isConfigured()) {
    return reject(503, "Terminal is not configured");
  }

  const ticket = url.searchParams.get("ticket");
  if (!ctx.tickets.consume(ticket, npub)) {
    return reject(403, "Invalid terminal ticket");
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
  return reject(400, "WebSocket upgrade failed");
}

export function createTerminalWebSocketHandler(ctx: TerminalWebSocketContext) {
  const sendError = (ws: ServerWebSocket<TerminalWebSocketData>, message: string) => {
    ctx.reportFailure?.("shell", message);
    if (ws.data.state !== "closed") ws.sendText(JSON.stringify({ type: "error", phase: "shell", message }));
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
      if (ws.data.state === "closed") return;
      if (record.type === "start") {
        if (ws.data.state) {
          sendError(ws, "Terminal shell has already been started");
          return;
        }
        ws.data.state = "starting";
        try {
          await ctx.sessions.start(ws.data.connectionId, ws, {
            cols: typeof record.cols === "number" ? record.cols : undefined,
            rows: typeof record.rows === "number" ? record.rows : undefined,
          });
          if ((ws.data.state as string) === "closed") return;
          ws.data.state = "ready";
          ws.sendText(JSON.stringify({ type: "ready" }));
        } catch (error) {
          sendError(ws, error instanceof Error ? error.message : String(error));
          ctx.sessions.close(ws.data.connectionId);
          if ((ws.data.state as string) !== "closed") ws.close(1011, "Terminal shell startup failed");
        }
        return;
      }
      if (ws.data.state !== "ready") return;
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
        ws.data.state = "closed";
        ctx.sessions.close(ws.data.connectionId);
      }
    },
  };
}

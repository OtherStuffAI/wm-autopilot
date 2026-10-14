import type { TerminalWebSocketContext } from "../server/terminal-websocket";
import type { InstanceSettingsStore } from "../storage/instance-settings-store";
import { writeServerLog } from "../logging/server-logger";
import { resolveTerminalConfig } from "./terminal-config";
import { TerminalSessionManager } from "./terminal-session-manager";
import { TerminalTicketStore } from "./terminal-ticket-store";
import { TerminalPinService } from "./terminal-pin-service";
import { TerminalPinRateLimiter } from "./terminal-pin-rate-limiter";

export function createTerminalRuntime(
  defaultCwd: string,
  publicOrigin: string,
  settingsStore: InstanceSettingsStore,
  isAdminNpub: TerminalWebSocketContext["isAdminNpub"],
) {
  const config = resolveTerminalConfig({ defaultCwd });
  const tickets = new TerminalTicketStore({ ttlMs: config.ticketTtlMs });
  const sessions = new TerminalSessionManager(config);
  const pinService = new TerminalPinService(settingsStore);
  const rateLimiter = new TerminalPinRateLimiter();
  const websocketContext: TerminalWebSocketContext = {
    publicOrigin,
    tickets,
    sessions,
    pinService,
    isAdminNpub,
    reportFailure: (phase, reason) => writeServerLog("WARN", "[terminal]", { phase, reason }),
  };
  return { config, tickets, sessions, pinService, rateLimiter, websocketContext };
}

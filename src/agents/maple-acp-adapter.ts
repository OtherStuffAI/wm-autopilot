import { isAbsolute } from "node:path";

import type { AdapterSessionContext } from "./agent-adapter";
import { AcpAdapter } from "./acp-adapter";

export const DEFAULT_MAPLE_ACP_CLI = "/Applications/Maple.app/Contents/MacOS/maple";

export const MAPLE_ACP_ENV_ALLOWLIST = [
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "XDG_RUNTIME_DIR",
] as const;

export function buildMapleAcpEnvironment(
  hostEnv: Record<string, string | undefined> = process.env,
  contextEnv: Record<string, string | undefined> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of MAPLE_ACP_ENV_ALLOWLIST) {
    const value = contextEnv[name] ?? hostEnv[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  return env;
}

export function resolveMapleAcpCli(context: AdapterSessionContext): string {
  const command = context.mapleAcpCli?.trim() || DEFAULT_MAPLE_ACP_CLI;
  if (!isAbsolute(command)) {
    throw new Error("Maple Desktop ACP executable must be configured as an absolute path in Instance Settings");
  }
  return command;
}

export class MapleAcpAdapter extends AcpAdapter {
  constructor(context: AdapterSessionContext) {
    super(context, {
      agentName: "Maple Desktop",
      command: resolveMapleAcpCli(context),
      args: ["acp"],
      env: buildMapleAcpEnvironment(process.env, context.env),
      protocolVersion: 1,
      sessionId: context.mapleSessionId,
      mcpServers: [],
      cancelIsNotification: true,
      aggregateAutoApprovedPermissions: true,
      rollIntermediateAgentMessages: true,
      formatStartupError: formatMapleStartupError,
    });
  }
}

export function formatMapleStartupError(error: Error): Error {
  const message = error.message;
  const normalized = message.toLowerCase();
  if (normalized.includes("protocol")) {
    return new Error(`Maple Desktop ACP protocol mismatch. Autopilot requires ACP version 1. ${message}`);
  }
  if (normalized.includes("service is unavailable") || normalized.includes("socket") && normalized.includes("no such file")) {
    return new Error(`Maple Desktop ACP service is stopped or unavailable. Enable it in Maple Desktop, then launch a fresh session. ${message}`);
  }
  if (normalized.includes("enoent") || normalized.includes("no such file")) {
    return new Error(`Maple Desktop ACP executable is missing. Set its absolute path in Instance Settings. ${message}`);
  }
  if (normalized.includes("sign") || normalized.includes("auth") || normalized.includes("login")) {
    return new Error(`Maple Desktop is signed out. Sign in in the Desktop app, then launch a fresh session. ${message}`);
  }
  if (normalized.includes("limit") || normalized.includes("too many") || normalized.includes("connection")) {
    return new Error(`Maple Desktop ACP connection is unavailable or its connection limit was reached. Close an unused Maple session or enable the Desktop ACP service, then retry. ${message}`);
  }
  return new Error(`Maple Desktop ACP could not start. Confirm Maple Desktop is running, signed in, and its ACP service is available. ${message}`);
}

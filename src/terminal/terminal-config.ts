import { isAbsolute, normalize, resolve } from "node:path";

export interface TerminalConfig {
  shell: string;
  cwd: string;
  ptyMode: TerminalPtyMode;
  ticketTtlMs: number;
}

export interface TerminalConfigInput {
  env?: Record<string, string | undefined>;
  defaultCwd: string;
}

const DEFAULT_TICKET_TTL_MS = 30_000;
export type TerminalPtyMode = "bridge" | "direct";

function parseTicketTtlMs(value: string | undefined): number {
  if (!value) return DEFAULT_TICKET_TTL_MS;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TICKET_TTL_MS;
  }
  return Math.min(parsed * 1000, 5 * 60 * 1000);
}

function parsePtyMode(value: string | undefined): TerminalPtyMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "bridge";
  if (normalized === "bridge" || normalized === "direct") return normalized;
  throw new Error('TMAN_PTY_MODE must be "bridge" or "direct"');
}

function expandHome(input: string, env: Record<string, string | undefined>): string {
  if (!input.startsWith("~")) return input;
  return input.replace("~", env.HOME ?? "~");
}

function resolveCwd(input: string | undefined, defaultCwd: string, env: Record<string, string | undefined>): string {
  const raw = input?.trim() || defaultCwd;
  const expanded = expandHome(raw, env);
  return normalize(isAbsolute(expanded) ? expanded : resolve(defaultCwd, expanded));
}

export function resolveTerminalConfig({
  env = Bun.env,
  defaultCwd,
}: TerminalConfigInput): TerminalConfig {
  const shell = env.TMAN_SHELL?.trim() || env.SHELL?.trim() || "/bin/bash";
  return {
    shell,
    cwd: resolveCwd(env.TMAN_CWD, defaultCwd, env),
    ptyMode: parsePtyMode(env.TMAN_PTY_MODE),
    ticketTtlMs: parseTicketTtlMs(env.TMAN_TICKET_TTL_SECONDS),
  };
}

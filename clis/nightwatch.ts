#!/usr/bin/env bun

/**
 * Wingman Night Watch CLI (NIP-98 authenticated).
 *
 * Commands: status, enable, disable, config, reports, report-delete
 */

import {
  parseCommonFlags,
  buildConfig,
  requestJson,
  requestJsonBotCrypto,
  resolveBaseUrl,
} from "./lib/auth";

interface SessionState {
  sessionId?: string;
  enabled?: boolean;
  cycleCount?: number;
  maxCycles?: number;
  prompt?: string | null;
  intervalMinutes?: number | null;
  promptAt?: string | null;
  [key: string]: unknown;
}

const USAGE = `Wingman Night Watch CLI (NIP-98)

Usage:
  bun clis/nightwatch.ts <command> [id] [options]

Commands:
  status <session-id>        Show Night Watch state for a live session
  enable <session-id>        Enable Night Watch for a live session
  disable <session-id>       Disable Night Watch for a live session
  config                     Show global Night Watch config
  reports                    List Night Watch reports
  report-delete <report-id>  Delete a Night Watch report

Options:
  --nightwatch-prompt <text> Prompt used by Night Watch check-ins
  --nightwatch-interval <n>  Minutes between Night Watch check-ins
  --nightwatch-max-cycles <n> Maximum number of Night Watch check-ins
  --url <url>                Wingman URL (env: WINGMAN_URL, default: http://localhost:3000)
  --key <nsec|hex>           Operator-only Nostr private key (env: WINGMAN_NSEC)
  --bot-crypto               Sign via bot-crypto API (for agent sessions)
  --json                     Print raw JSON response
  -h, --help                 Show help

Examples:
  bun clis/nightwatch.ts status abc123
  bun clis/nightwatch.ts enable abc123 --nightwatch-prompt "Any progress?" --nightwatch-interval 10
  bun clis/nightwatch.ts disable abc123
  bun clis/nightwatch.ts config
  bun clis/nightwatch.ts reports`;

function parsePositiveIntegerFlag(value: string | undefined, flagName: string): number {
  if (value === undefined) {
    throw new Error(`${flagName} requires a numeric value`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }
  return parsed;
}

function printState(state: SessionState): void {
  console.log(`Session:        ${String(state.sessionId ?? "-")}`);
  console.log(`Enabled:        ${state.enabled ? "yes" : "no"}`);
  console.log(`Cycle Count:    ${String(state.cycleCount ?? 0)}`);
  console.log(`Max Cycles:     ${String(state.maxCycles ?? "-")}`);
  console.log(`Interval Min:   ${String(state.intervalMinutes ?? "-")}`);
  console.log(`Prompt At:      ${String(state.promptAt ?? "-")}`);
  console.log(`Prompt:         ${String(state.prompt ?? "-")}`);
}

async function run(): Promise<void> {
  const { args, urlInput, keyInput, asJson, help, botCrypto } = parseCommonFlags(Bun.argv.slice(2));
  let nightwatchPrompt: string | undefined;
  let nightwatchInterval: number | undefined;
  let nightwatchMaxCycles: number | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === "--nightwatch-prompt") {
      nightwatchPrompt = args[++i];
      if (!nightwatchPrompt) throw new Error("--nightwatch-prompt requires a value");
    } else if (flag === "--nightwatch-interval") {
      nightwatchInterval = parsePositiveIntegerFlag(args[++i], "--nightwatch-interval");
    } else if (flag === "--nightwatch-max-cycles") {
      nightwatchMaxCycles = parsePositiveIntegerFlag(args[++i], "--nightwatch-max-cycles");
    } else {
      positional.push(flag);
    }
  }

  const command = positional[0]?.toLowerCase() ?? "help";
  if (help || command === "help") {
    console.log(USAGE);
    return;
  }

  const baseUrl = resolveBaseUrl(urlInput);
  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (botCrypto) {
      return requestJsonBotCrypto<T>(baseUrl, method, path, body);
    }
    const { secretKey } = buildConfig(urlInput, keyInput);
    return requestJson<T>(baseUrl, secretKey, method, path, body);
  }

  function buildEnableBody(): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (nightwatchPrompt !== undefined) body.prompt = nightwatchPrompt;
    if (nightwatchInterval !== undefined) body.intervalMinutes = nightwatchInterval;
    if (nightwatchMaxCycles !== undefined) body.maxCycles = nightwatchMaxCycles;
    return body;
  }

  switch (command) {
    case "status": {
      const sessionId = positional[1];
      if (!sessionId) throw new Error("status requires <session-id>");
      const payload = await req<SessionState>("GET", `/api/nightwatch/sessions/${encodeURIComponent(sessionId)}`);
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        printState(payload);
      }
      break;
    }

    case "enable": {
      const sessionId = positional[1];
      if (!sessionId) throw new Error("enable requires <session-id>");
      const payload = await req<SessionState>(
        "POST",
        `/api/nightwatch/sessions/${encodeURIComponent(sessionId)}/enable`,
        buildEnableBody(),
      );
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`Enabled Night Watch for ${sessionId}`);
      }
      break;
    }

    case "disable": {
      const sessionId = positional[1];
      if (!sessionId) throw new Error("disable requires <session-id>");
      const payload = await req<SessionState>(
        "POST",
        `/api/nightwatch/sessions/${encodeURIComponent(sessionId)}/disable`,
      );
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`Disabled Night Watch for ${sessionId}`);
      }
      break;
    }

    case "config": {
      const payload = await req<Record<string, unknown>>("GET", "/api/nightwatch/config");
      console.log(JSON.stringify(payload, null, 2));
      break;
    }

    case "reports": {
      const payload = await req<Record<string, unknown>>("GET", "/api/nightwatch/reports");
      console.log(JSON.stringify(payload, null, 2));
      break;
    }

    case "report-delete": {
      const reportId = positional[1];
      if (!reportId) throw new Error("report-delete requires <report-id>");
      await req("DELETE", `/api/nightwatch/reports/${encodeURIComponent(reportId)}`);
      console.log(`Deleted Night Watch report: ${reportId}`);
      break;
    }

    default:
      throw new Error(`Unknown command: ${command}. Run with --help for usage.`);
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});

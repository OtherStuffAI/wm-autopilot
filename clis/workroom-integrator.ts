#!/usr/bin/env bun

import { buildAuthConfig, requestJsonWithAuth, type CliAuthConfig } from "./lib/auth";
import { FlightDeckPgClient, resolveFlightDeckPgConfig } from "../src/flightdeck-pg/client";
import { fetchFlightDeckDispatchContext } from "../src/flightdeck-pg/cli";
import { GitHubApiClient, getGitHubCredentialsForNpub } from "../src/git/github-api";
import { runWorkroomIntegrationLoop, type WorkroomAppAction } from "../src/workrooms/integration-loop";

type FlagMap = Map<string, string | boolean>;

async function main() {
  if (process.execArgv.includes("--check")) return;
  const { flags } = parseFlags(process.argv.slice(2));
  const workspaceId = requiredFlag(flags, "--workspace", "workspace id");
  const workroomId = requiredFlag(flags, "--workroom", "workroom id");
  const githubToken = resolveGitHubToken(flags);
  const wingmanUrl = stringFlag(flags, "--url") ?? undefined;
  const keyInput = stringFlag(flags, "--key") ?? undefined;
  const useBotCrypto = flags.has("--bot-crypto") || Boolean(!keyInput && Bun.env.SESSION_ID?.trim() && Bun.env.WINGMAN_CAPABILITY?.trim());
  const auth = buildAuthConfig(wingmanUrl, keyInput, useBotCrypto);
  const sessionId = stringFlag(flags, "--session-id") ?? Bun.env.SESSION_ID ?? null;
  const dispatchContext = "botCrypto" in auth && sessionId
    ? await fetchFlightDeckDispatchContext({ wingmanUrl: auth.brokerUrl, sessionId })
    : null;
  const dispatchWorkspace = dispatchContext?.workspace && typeof dispatchContext.workspace === "object"
    ? dispatchContext.workspace as Record<string, unknown>
    : {};
  const needsAppControl = Boolean(stringFlag(flags, "--app-action") || flags.has("--deploy-caprover"));
  const flightDeck = new FlightDeckPgClient(resolveFlightDeckPgConfig({
    towerUrl: stringFlag(flags, "--tower-url")
      ?? stringValue(dispatchWorkspace.backendBaseUrl)
      ?? Bun.env.TOWER_URL
      ?? Bun.env.FLIGHTDECK_TOWER_URL,
    wingmanUrl: auth.baseUrl,
    appNpub: stringFlag(flags, "--app-npub")
      ?? stringValue(dispatchWorkspace.sourceAppNpub)
      ?? Bun.env.FLIGHTDECK_APP_NPUB,
    secretKey: "secretKey" in auth ? auth.secretKey : null,
    botCrypto: "botCrypto" in auth,
    sessionId,
    initialContext: dispatchContext,
  }));
  const github = new GitHubApiClient(githubToken);
  const appControl = needsAppControl ? makeAppControlClient(auth) : null;
  const result = await runWorkroomIntegrationLoop({
    flightDeck,
    github,
    appControl,
    options: {
      workspaceId,
      workroomId,
      dryRun: !flags.has("--live"),
      merge: flags.has("--merge"),
      updateProduction: flags.has("--update-production"),
      productionCommit: stringFlag(flags, "--production-commit"),
      productionBranch: stringFlag(flags, "--production-branch"),
      mergeMethod: mergeMethodFlag(flags),
      appTarget: stringFlag(flags, "--app-target"),
      appAction: appActionFlag(flags),
      deployCaprover: flags.has("--deploy-caprover"),
      caproverName: stringFlag(flags, "--caprover-name"),
    },
  });
  console.log(JSON.stringify(result, null, 2));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function makeAppControlClient(auth: CliAuthConfig) {
  return {
    async runAppAction(appId: string, action: WorkroomAppAction) {
      return await requestJsonWithAuth<Record<string, unknown>>(auth, "POST", `/api/apps/${encodeURIComponent(appId)}/actions`, { action });
    },
    async deployToCaprover(appId: string, input?: { caproverName?: string | null }) {
      return await requestJsonWithAuth<Record<string, unknown>>(auth, "POST", `/api/apps/${encodeURIComponent(appId)}/deploy-to-caprover`, {
        caproverName: input?.caproverName || appId,
      });
    },
  };
}

function resolveGitHubToken(flags: FlagMap): string {
  const explicit = stringFlag(flags, "--github-token");
  if (explicit) return explicit;
  const ownerNpub = stringFlag(flags, "--github-owner-npub") || stringFlag(flags, "--owner-npub");
  if (ownerNpub) {
    const creds = getGitHubCredentialsForNpub(ownerNpub);
    if (creds?.token) return creds.token;
    throw new Error(`No Autopilot-managed GitHub token found for ${ownerNpub}`);
  }
  const envToken = (Bun.env.GITHUB_TOKEN || Bun.env.GH_TOKEN || "").trim();
  if (envToken) return envToken;
  throw new Error("Missing GitHub token. Pass --github-owner-npub to use Autopilot-managed user settings, --github-token, or set GITHUB_TOKEN.");
}

function mergeMethodFlag(flags: FlagMap): "merge" | "squash" | "rebase" | undefined {
  const value = stringFlag(flags, "--merge-method");
  if (!value) return undefined;
  if (value === "merge" || value === "squash" || value === "rebase") return value;
  throw new Error("--merge-method must be merge, squash, or rebase");
}

function appActionFlag(flags: FlagMap): WorkroomAppAction | undefined {
  const value = stringFlag(flags, "--app-action");
  if (!value) return undefined;
  if (value === "start" || value === "restart" || value === "build" || value === "setup") return value;
  throw new Error("--app-action must be start, restart, build, or setup");
}

function parseFlags(argv: string[]): { flags: FlagMap; positionals: string[] } {
  const flags: FlagMap = new Map();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      flags.set(arg, true);
      continue;
    }
    flags.set(arg, next);
    index += 1;
  }
  return { flags, positionals };
}

function stringFlag(flags: FlagMap, name: string): string | null {
  const value = flags.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredFlag(flags: FlagMap, name: string, label: string): string {
  const value = stringFlag(flags, name);
  if (!value) throw new Error(`Missing required ${label}. Pass ${name}.`);
  return value;
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exit(1);
});

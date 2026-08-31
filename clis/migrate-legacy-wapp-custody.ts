#!/usr/bin/env bun

import {
  buildConfig,
  parseCommonFlags,
  requestJson,
  requestJsonBotCrypto,
  resolveBaseUrl,
} from "./lib/auth";
import { WAPP_LEGACY_CUSTODY_MIGRATION_PATH } from "../src/server/wapp-legacy-custody-migration-route";
import type { LegacyWappCustodyMigrationInput } from "../src/wapps/legacy-custody-migration-contract";

const USAGE = `Legacy WApp encrypted-custody migration

Dry-run is the default. The named source file is read by the local Autopilot
process; never pass WAPP_NSEC itself to this command.

Usage:
  bun clis/migrate-legacy-wapp-custody.ts <app-id> \\
    --source-env-file <absolute-path> \\
    --expected-app-npub <npub> \\
    --installation-id <id> \\
    --title <title> \\
    --installation-owner-npub <npub> \\
    --created-by-npub <npub> \\
    --workspace-owner-npub <npub> \\
    --scope-id <id> \\
    --allowed-npub <npub> [--allowed-npub <npub> ...] \\
    --launch-url <url> \\
    --tower-binding-id <id> [options]

Options:
  --description <text>
  --source-wingman-url <url>
  --subdomain-alias <alias>
  --registered-open-origin <url>  Repeat for each allowed origin
  --auto-start <true|false>       Omit to preserve the current value
  --apply                         Write custody, clean the source, and clear the obsolete review reason
  --url <url>                     Local Autopilot URL
  --bot-crypto                    Authenticate through the session capability broker
  --json                          Print the non-secret response as JSON
  -h, --help
`;

interface ParsedMigrationFlags {
  input: LegacyWappCustodyMigrationInput;
  help: boolean;
  urlInput?: string;
  keyInput?: string;
  botCrypto: boolean;
  asJson: boolean;
}

function booleanValue(value: string | undefined, flag: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${flag} requires true or false`);
}

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseLegacyWappCustodyMigrationArgs(argv: string[]): ParsedMigrationFlags {
  const common = parseCommonFlags(argv);
  const values = new Map<string, string>();
  const allowedNpubs: string[] = [];
  const registeredOpenOrigins: string[] = [];
  let apply = false;
  const positionals: string[] = [];
  for (let index = 0; index < common.args.length; index += 1) {
    const token = common.args[index]!;
    if (token === "--apply") {
      apply = true;
      continue;
    }
    if (token === "--allowed-npub" || token === "--registered-open-origin") {
      const value = takeValue(common.args, index, token);
      (token === "--allowed-npub" ? allowedNpubs : registeredOpenOrigins).push(value);
      index += 1;
      continue;
    }
    if (token.startsWith("--")) {
      const value = takeValue(common.args, index, token);
      values.set(token, value);
      index += 1;
      continue;
    }
    positionals.push(token);
  }
  if (common.help) {
    return {
      input: {} as LegacyWappCustodyMigrationInput,
      help: true,
      urlInput: common.urlInput,
      keyInput: common.keyInput,
      botCrypto: common.botCrypto,
      asJson: common.asJson,
    };
  }
  const knownFlags = new Set([
    "--source-env-file",
    "--expected-app-npub",
    "--installation-id",
    "--title",
    "--description",
    "--installation-owner-npub",
    "--created-by-npub",
    "--workspace-owner-npub",
    "--scope-id",
    "--launch-url",
    "--tower-binding-id",
    "--source-wingman-url",
    "--subdomain-alias",
    "--auto-start",
  ]);
  for (const flag of values.keys()) {
    if (!knownFlags.has(flag)) throw new Error(`Unknown option: ${flag}`);
  }
  if (positionals.length !== 1) throw new Error("Exactly one <app-id> is required");
  const required = (flag: string): string => {
    const value = values.get(flag)?.trim();
    if (!value) throw new Error(`${flag} is required`);
    return value;
  };
  const optional = (flag: string): string | undefined => values.get(flag)?.trim() || undefined;
  const input: LegacyWappCustodyMigrationInput = {
    appId: positionals[0]!,
    sourceEnvFile: required("--source-env-file"),
    expectedAppNpub: required("--expected-app-npub"),
    towerBindingId: required("--tower-binding-id"),
    installation: {
      installationId: required("--installation-id"),
      title: required("--title"),
      description: optional("--description"),
      ownerNpub: required("--installation-owner-npub"),
      createdByNpub: required("--created-by-npub"),
      workspaceOwnerNpub: required("--workspace-owner-npub"),
      scopeId: required("--scope-id"),
      allowedNpubs,
      launchUrl: required("--launch-url"),
      sourceWingmanUrl: optional("--source-wingman-url"),
      subdomainAlias: optional("--subdomain-alias"),
      registeredOpenOrigins: registeredOpenOrigins.length > 0 ? registeredOpenOrigins : undefined,
    },
    apply,
    autoStart: values.has("--auto-start")
      ? booleanValue(values.get("--auto-start"), "--auto-start")
      : undefined,
  };
  return {
    input,
    help: false,
    urlInput: common.urlInput,
    keyInput: common.keyInput,
    botCrypto: common.botCrypto,
    asJson: common.asJson,
  };
}

async function run(): Promise<void> {
  const parsed = parseLegacyWappCustodyMigrationArgs(Bun.argv.slice(2));
  if (parsed.help) {
    console.log(USAGE);
    return;
  }
  const baseUrl = resolveBaseUrl(parsed.urlInput);
  // This route is fetched over loopback, while NIP-98 verification
  // canonicalises the signed URL to the configured public Autopilot origin.
  const signingBaseUrl = resolveBaseUrl(Bun.env.WINGMAN_URL);
  const payload = parsed.botCrypto
    ? await requestJsonBotCrypto<{ migration: Record<string, unknown> }>(
      baseUrl,
      "POST",
      WAPP_LEGACY_CUSTODY_MIGRATION_PATH,
      parsed.input,
      undefined,
      signingBaseUrl,
    )
    : await requestJson<{ migration: Record<string, unknown> }>(
      baseUrl,
      buildConfig(parsed.urlInput, parsed.keyInput).secretKey,
      "POST",
      WAPP_LEGACY_CUSTODY_MIGRATION_PATH,
      parsed.input,
    );
  if (parsed.asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const result = payload.migration;
  console.log([
    result.dryRun ? "Dry run complete" : "Legacy custody migration applied",
    `app=${String(result.appId ?? "")}`,
    `installation=${String(result.installationId ?? "")}`,
    `identity=${String(result.appNpub ?? "")}`,
    `assignment=${String(result.assignment ?? "")}`,
    `custodyVerified=${String(result.custodyVerified ?? false)}`,
    `sourceSecretRemoved=${String(result.sourceSecretRemoved ?? false)}`,
    `autoStart=${String(result.autoStart ?? false)}`,
  ].join(" "));
}

if (import.meta.main) {
  run().catch((error) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

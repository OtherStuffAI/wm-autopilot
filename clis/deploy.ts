#!/usr/bin/env bun

/**
 * Wingman deployment CLI (NIP-98 authenticated).
 *
 * Commands: list, deploy, status, logs
 * Wraps the CapRover deployment routes in the Wingman API.
 */

import { parseCommonFlags, buildAuthConfig, requestJsonWithAuth } from "./lib/auth";

import { parseCommandOptions, validateCommandArguments, ownerApiPath } from "./lib/command-options";

const USAGE = `Wingman deployment CLI (NIP-98)

Usage:
  bun clis/deploy.ts <command> [app-id] [options]

Commands:
  list                 List registered apps with deployment info
  deploy <app-id>      Deploy an app to CapRover
  status <app-id>      Show app deployment status
  deployments <app-id> Inspect CapRover targets for an exact registered app
  logs <app-id>        Show app logs

Options:
  --url <url>          Wingman URL (env: WINGMAN_URL, default: http://localhost:3600)
  --key <nsec|hex>     Operator-only Nostr private key (env: WINGMAN_NSEC)
  --target <name>     Required exact target for deploy; optional filter for deployments
  --owner <npub>      Select owner space
  --bot-crypto        Use session capability broker
  --caprover-name <n>  CapRover app name (for deploy, defaults to app-id)
  --json               Print raw JSON response
  -h, --help           Show help

Examples:
  bun clis/deploy.ts list
  bun clis/deploy.ts deploy my-app --target production --caprover-name my-app-prod
  bun clis/deploy.ts status my-app
  bun clis/deploy.ts logs my-app`;

async function run() {
  const { args, urlInput, keyInput, asJson, help, botCrypto } = parseCommonFlags(Bun.argv.slice(2));

  const { positional, options } = parseCommandOptions(args, { "--owner": "value", "--caprover-name": "value", "--target": "value" });
  const target = (options["--target"] as string | undefined)?.trim();
  const owner = options["--owner"] as string | undefined;
  const caproverName = options["--caprover-name"] as string | undefined;
  const command = positional[0]?.toLowerCase() ?? "help";

  if (help || command === "help") {
    console.log(USAGE);
    return;
  }

  validateCommandArguments(command, positional, { list: 1, deploy: 2, status: 2, logs: 2, deployments: 2 });
  if (caproverName && command !== "deploy" && command !== "deployments") throw new Error("--caprover-name requires deploy or deployments");
  if (target && command !== "deploy" && command !== "deployments") throw new Error("--target requires deploy or deployments");
  if (command === "deploy" && (!target || target.toLowerCase() === "all")) throw new Error("deploy requires an explicit --target <name>; all is not allowed");
  const auth = buildAuthConfig(urlInput, keyInput, botCrypto);
  const req = <T>(method: string, path: string, body?: unknown) => requestJsonWithAuth<T>(auth, method, ownerApiPath(path, owner), body);
  const appId = positional[1];

  switch (command) {
    case "list": {
      const payload = await req<{ apps?: Array<Record<string, unknown>> }>(
        "GET", "/api/apps",
      );
      if (!Array.isArray(payload.apps)) throw new Error("Invalid apps response");
      const apps = payload.apps;
      if (asJson) {
        console.log(JSON.stringify(apps, null, 2));
      } else {
        if (apps.length === 0) {
          console.log("No apps registered.");
        } else {
          for (const app of apps) {
            const webApp = app.webApp ? "web" : "cli";
            console.log(`${app.id}\t${webApp}\t${app.label ?? app.id}`);
          }
        }
      }
      break;
    }

    case "deployments": {
      const query = caproverName ? `?caproverName=${encodeURIComponent(caproverName)}` : "";
      const payload = await req<Record<string, unknown>>("GET", `/api/apps/${encodeURIComponent(appId!)}/caprover/deployments${query}`);
      if (target) {
        if (!Array.isArray(payload.targets)) throw new Error("Invalid CapRover inspection response");
        const matches = payload.targets.filter(item => item && typeof item === "object" && item.name === target);
        if (matches.length !== 1) throw new Error(`Expected exactly one CapRover target named ${target}`);
        console.log(JSON.stringify({ ...payload, targets: matches }, null, 2));
      } else {
        console.log(JSON.stringify(payload, null, 2));
      }
      break;
    }

    case "deploy": {
      if (!appId) throw new Error("deploy requires <app-id>");
      const body: Record<string, unknown> = {
        caproverName: caproverName ?? appId,
        caproverTarget: target,
      };
      const payload = await req<Record<string, unknown>>(
        "POST",
        `/api/apps/${encodeURIComponent(appId)}/deploy-to-caprover`,
        body,
      );
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        const liveUrl = payload.liveUrl ?? "N/A";
        const version = payload.deployedVersion ?? "?";
        console.log(`Deployed: ${appId}`);
        console.log(`  URL: ${liveUrl}`);
        console.log(`  Version: ${version}`);
      }
      break;
    }

    case "status": {
      if (!appId) throw new Error("status requires <app-id>");
      const payload = await req<Record<string, unknown>>(
        "GET",
        `/api/apps/${encodeURIComponent(appId)}`,
      );
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        const app = (payload.app ?? payload) as Record<string, unknown>;
        console.log(`App: ${app.id ?? appId}`);
        console.log(`  Label: ${app.label ?? "-"}`);
        console.log(`  WebApp: ${app.webApp ? "yes" : "no"}`);
        console.log(`  Directory: ${app.directory ?? "-"}`);
        if (app.status) {
          const status = typeof app.status === "object" ? JSON.stringify(app.status) : String(app.status);
          console.log(`  Status: ${status}`);
        }
      }
      break;
    }

    case "logs": {
      if (!appId) throw new Error("logs requires <app-id>");
      const payload = await req<{ logs: string[] }>(
        "GET",
        `/api/apps/${encodeURIComponent(appId)}/logs`,
      );
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        if (!Array.isArray(payload.logs) || !payload.logs.every(line => typeof line === "string")) throw new Error("Invalid logs response");
        const output = payload.logs.join("\n");
        if (output) {
          console.log(output);
        } else {
          console.log("No logs available.");
        }
      }
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

#!/usr/bin/env bun

/**
 * Wingman deployment CLI (NIP-98 authenticated).
 *
 * Commands: list, deploy, status, logs
 * Wraps the CapRover deployment routes in the Wingman API.
 */

import { parseCommonFlags, buildConfig, requestJson } from "./lib/auth";

const USAGE = `Wingman deployment CLI (NIP-98)

Usage:
  bun clis/deploy.ts <command> [app-id] [options]

Commands:
  list                 List registered apps with deployment info
  deploy <app-id>      Deploy an app to CapRover
  status <app-id>      Show app deployment status
  logs <app-id>        Show app logs

Options:
  --url <url>          Wingman URL (env: WINGMAN_URL, default: http://localhost:3000)
  --key <nsec|hex>     Operator-only Nostr private key (env: WINGMAN_NSEC)
  --caprover-name <n>  CapRover app name (for deploy, defaults to app-id)
  --json               Print raw JSON response
  -h, --help           Show help

Examples:
  bun clis/deploy.ts list
  bun clis/deploy.ts deploy my-app --caprover-name my-app-prod
  bun clis/deploy.ts status my-app
  bun clis/deploy.ts logs my-app`;

async function run() {
  const { args, urlInput, keyInput, asJson, help } = parseCommonFlags(Bun.argv.slice(2));

  // Extract deploy-specific flags
  let caproverName: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === "--caprover-name") {
      caproverName = args[++i];
      if (!caproverName) throw new Error("--caprover-name requires a value");
    } else {
      positional.push(flag);
    }
  }

  const command = positional[0]?.toLowerCase() ?? "help";

  if (help || command === "help") {
    console.log(USAGE);
    return;
  }

  const { baseUrl, secretKey } = buildConfig(urlInput, keyInput);
  const appId = positional[1];

  switch (command) {
    case "list": {
      const payload = await requestJson<{ apps?: Array<Record<string, unknown>> }>(
        baseUrl, secretKey, "GET", "/api/apps",
      );
      const apps = Array.isArray(payload.apps) ? payload.apps : [];
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

    case "deploy": {
      if (!appId) throw new Error("deploy requires <app-id>");
      const body: Record<string, unknown> = {
        caproverName: caproverName ?? appId,
      };
      const payload = await requestJson<Record<string, unknown>>(
        baseUrl, secretKey, "POST",
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
      const payload = await requestJson<Record<string, unknown>>(
        baseUrl, secretKey, "GET",
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
      const payload = await requestJson<{ logs?: string; lines?: string[] }>(
        baseUrl, secretKey, "GET",
        `/api/apps/${encodeURIComponent(appId)}/logs`,
      );
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        const output = payload.logs ?? (payload.lines ?? []).join("\n");
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

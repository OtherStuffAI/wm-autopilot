#!/usr/bin/env bun

/**
 * Wingman app lifecycle CLI (NIP-98 authenticated).
 *
 * Commands: list, status, start, stop, restart, build, setup, register, unregister,
 *           clone, starters, starters-create, starters-delete, domains, domain-add,
 *           domain-verify, domain-remove
 */

import {
  buildAuthHeader,
  buildBotCryptoAuthHeader,
  parseCommonFlags,
  buildConfig,
  requestJson,
  requestJsonBotCrypto,
  resolveBaseUrl,
  resolveCapabilityBrokerUrl,
} from "./lib/auth";

type AppAction = "start" | "stop" | "restart" | "build" | "setup";
type DomainStatus = "pending_dns" | "active" | "disabled" | "error";
type Command =
  | "list"
  | "status"
  | AppAction
  | "register"
  | "unregister"
  | "clone"
  | "starters"
  | "starters-create"
  | "starters-delete"
  | "tower-bindings"
  | "tower-binding-create"
  | "tower-binding-default"
  | "wapp-publisher-repair"
  | "review-wapp-tower-broker"
  | "domains"
  | "domain-add"
  | "domain-verify"
  | "domain-remove"
  | "cf-tunnel-upsert"
  | "cf-tunnel-verify"
  | "cf-tunnel-remove"
  | "help";

const USAGE = `Wingman app lifecycle CLI (NIP-98)

Usage:
  bun clis/appctl.ts <command> [app-id] [options]

Commands:
  list                 List registered apps
  status <app-id>      Show app details and runtime status
  start <app-id>       Start app
  stop <app-id>        Stop app
  restart <app-id>     Restart app
  build <app-id>       Run app build script
  setup <app-id>       Run app setup script
  register <app-id>    Register an app (requires --directory)
  unregister <app-id>  Unregister an app
  clone <repo-url>     Clone a git repo into the workspace
  starters             List starter project templates
  starters-create      Create a starter template (requires --name, --git-url)
  starters-delete <id> Delete a starter template
  tower-bindings       List WApp Tower bindings
  tower-binding-create Create WApp Tower binding (requires --name, --tower-url, --workspace-owner-npub)
  tower-binding-default <id> Select default WApp Tower binding
  wapp-publisher-repair <wapp-installation-id>
                       Generate, approve, and activate a missing WApp publisher key
  review-wapp-tower-broker <app-id>
                       Re-discover safe scripts and clear only the obsolete raw-key review reason
  domains <app-id>     List real DNS names registered for an app
  domain-add <app-id> <hostname>
                       Register a real DNS name for an app
  domain-verify <app-id> <hostname>
                       Mark a real DNS name verified and active
  domain-remove <app-id> <hostname>
                       Remove a real DNS name from an app
  cf-tunnel-upsert <hostname> <service-url>
                       Configure Cloudflare Tunnel public hostname and DNS
  cf-tunnel-verify <hostname> <service-url>
                       Verify Cloudflare Tunnel public hostname and DNS
  cf-tunnel-remove <hostname>
                       Remove Cloudflare Tunnel public hostname

Options:
  --url <url>          Wingman URL (env: WINGMAN_URL, default: http://localhost:3000)
  --key <nsec|hex>     Operator-only Nostr private key (env: WINGMAN_NSEC)
  --directory <path>   App directory (for register) or folder name (for clone)
  --name <name>        Starter project name (for starters-create)
  --git-url <url>      Git repo URL (for starters-create)
  --tower-url <url>    Tower base URL (for tower-binding-create)
  --workspace-owner-npub <npub> Workspace owner npub (for tower-binding-create)
  --owner <npub>        Use an Admin owner-space app route for delegated operation
  --user-alias <alias> User alias to inject into Tower-backed WApps
  --service-url <url>  Tunnel origin service URL (for cf-tunnel-upsert/verify)
  --status <status>    Domain status for domain-add: pending_dns, active, disabled, error
  --default            Mark created WApp Tower binding as default
  --web-app            Mark as a web app (for register and starters-create)
  --delete-dns         Delete Cloudflare DNS record when removing tunnel hostname
  --bot-crypto         Sign via bot-crypto API (for agent sessions)
  --json               Print raw JSON response
  -h, --help           Show help

Examples:
  bun clis/appctl.ts list
  bun clis/appctl.ts status my-app
  bun clis/appctl.ts start my-app --url http://localhost:3600
  bun clis/appctl.ts clone https://github.com/org/repo.git --directory my-project
  bun clis/appctl.ts starters
  bun clis/appctl.ts starters-create --name "My Template" --git-url https://github.com/org/repo
  bun clis/appctl.ts domain-add my-app brandname.com
  bun clis/appctl.ts cf-tunnel-upsert brandname.com http://localhost:3600`;

function resolveAppStatus(app: Record<string, unknown> | undefined): { status: string; running: boolean } {
  if (!app) return { status: "unknown", running: false };

  const statusValue = app.status;
  const nestedStatus =
    statusValue && typeof statusValue === "object" ? (statusValue as Record<string, unknown>) : null;

  const status =
    typeof statusValue === "string"
      ? statusValue
      : typeof nestedStatus?.status === "string"
        ? (nestedStatus.status as string)
        : "unknown";

  const running =
    typeof app.running === "boolean"
      ? app.running
      : typeof nestedStatus?.running === "boolean"
        ? (nestedStatus.running as boolean)
        : false;

  return { status, running };
}

function printList(payload: { apps?: Array<Record<string, unknown>> }) {
  const apps = Array.isArray(payload.apps) ? payload.apps : [];
  if (apps.length === 0) {
    console.log("No apps registered.");
    return;
  }
  for (const app of apps) {
    const id = String(app.id ?? "");
    const label = String(app.label ?? id);
    const { status, running } = resolveAppStatus(app);
    console.log(`${id}\t${label}\t${status}\trunning=${running ? "yes" : "no"}`);
  }
}

function parseDomainStatus(value: string | undefined): DomainStatus | undefined {
  if (!value) return undefined;
  if (value === "pending_dns" || value === "active" || value === "disabled" || value === "error") {
    return value;
  }
  throw new Error("--status must be one of: pending_dns, active, disabled, error");
}

function printDomains(payload: { domains?: Array<Record<string, unknown>> }) {
  const domains = Array.isArray(payload.domains) ? payload.domains : [];
  if (domains.length === 0) {
    console.log("No real DNS names registered.");
    return;
  }
  for (const domain of domains) {
    const hostname = String(domain.hostname ?? "");
    const status = String(domain.status ?? "unknown");
    const verified = domain.verified ? "yes" : "no";
    const error = typeof domain.error === "string" && domain.error ? `\terror=${domain.error}` : "";
    console.log(`${hostname}\t${status}\tverified=${verified}${error}`);
  }
}

async function run() {
  const { args, urlInput, keyInput, asJson, help, botCrypto } = parseCommonFlags(Bun.argv.slice(2));

  // Extract command-specific flags from remaining args
  let directory: string | undefined;
  let starterName: string | undefined;
  let gitUrl: string | undefined;
  let towerUrl: string | undefined;
  let workspaceOwnerNpub: string | undefined;
  let ownerNpub: string | undefined;
  let userAlias: string | undefined;
  let serviceUrl: string | undefined;
  let domainStatus: DomainStatus | undefined;
  let makeDefault = false;
  let webApp = false;
  let deleteDns = false;
  const filteredArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === "--directory") {
      directory = args[++i];
      if (!directory) throw new Error("--directory requires a value");
    } else if (flag === "--name") {
      starterName = args[++i];
      if (!starterName) throw new Error("--name requires a value");
    } else if (flag === "--git-url") {
      gitUrl = args[++i];
      if (!gitUrl) throw new Error("--git-url requires a value");
    } else if (flag === "--tower-url") {
      towerUrl = args[++i];
      if (!towerUrl) throw new Error("--tower-url requires a value");
    } else if (flag === "--workspace-owner-npub") {
      workspaceOwnerNpub = args[++i];
      if (!workspaceOwnerNpub) throw new Error("--workspace-owner-npub requires a value");
    } else if (flag === "--owner") {
      ownerNpub = args[++i];
      if (!ownerNpub) throw new Error("--owner requires a value");
    } else if (flag === "--user-alias") {
      userAlias = args[++i];
      if (!userAlias) throw new Error("--user-alias requires a value");
    } else if (flag === "--service-url") {
      serviceUrl = args[++i];
      if (!serviceUrl) throw new Error("--service-url requires a value");
    } else if (flag === "--status") {
      domainStatus = parseDomainStatus(args[++i]);
    } else if (flag === "--default") {
      makeDefault = true;
    } else if (flag === "--web-app") {
      webApp = true;
    } else if (flag === "--delete-dns") {
      deleteDns = true;
    } else {
      filteredArgs.push(flag);
    }
  }

  // Parse command
  const commandStr = filteredArgs[0]?.toLowerCase() ?? "help";
  const validCommands = [
    "list", "status", "start", "stop", "restart", "build", "setup",
    "register", "unregister", "clone", "starters", "starters-create", "starters-delete",
    "tower-bindings", "tower-binding-create", "tower-binding-default", "wapp-publisher-repair", "review-wapp-tower-broker",
    "domains", "domain-add", "domain-verify", "domain-remove",
    "cf-tunnel-upsert", "cf-tunnel-verify", "cf-tunnel-remove", "help",
  ];
  if (!validCommands.includes(commandStr)) {
    throw new Error(`Unknown command: ${commandStr}`);
  }
  const command = (help ? "help" : commandStr) as Command;
  const appId = filteredArgs[1];
  const secondArg = filteredArgs[2];

  if (command === "help") {
    console.log(USAGE);
    return;
  }

  const baseUrl = resolveBaseUrl(urlInput);
  const appsPath = (suffix = ""): string =>
    ownerNpub
      ? `/api/owners/${encodeURIComponent(ownerNpub)}/apps${suffix}`
      : `/api/apps${suffix}`;

  // Unified request helper: bot-crypto signs via API, otherwise uses local key
  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (botCrypto) {
      return requestJsonBotCrypto<T>(baseUrl, method, path, body);
    }
    const { secretKey } = buildConfig(urlInput, keyInput);
    return requestJson<T>(baseUrl, secretKey, method, path, body);
  }

  if (command === "list") {
    const payload = await req<{ apps?: Array<Record<string, unknown>> }>(
      "GET", appsPath(),
    );
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      printList(payload);
    }
    return;
  }

  if (command === "starters") {
    const payload = await req<{ projects?: Array<Record<string, unknown>> }>(
      "GET", "/api/apps/starter-projects",
    );
    const projects = Array.isArray(payload.projects)
      ? payload.projects
      : Array.isArray(payload) ? (payload as Array<Record<string, unknown>>) : [];
    if (asJson) {
      console.log(JSON.stringify(projects, null, 2));
    } else {
      if (projects.length === 0) {
        console.log("No starter projects.");
      } else {
        for (const p of projects) {
          const webFlag = p.webApp ? "web" : "cli";
          console.log(`${p.id}\t${p.name ?? "-"}\t${webFlag}\t${p.gitUrl ?? "-"}`);
        }
      }
    }
    return;
  }

  if (command === "tower-bindings") {
    const payload = await req<{ bindings?: Array<Record<string, unknown>>; defaultBinding?: Record<string, unknown> | null }>(
      "GET", "/api/wapps/tower-bindings",
    );
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      const bindings = Array.isArray(payload.bindings) ? payload.bindings : [];
      if (bindings.length === 0) {
        console.log("No WApp Tower bindings.");
      } else {
        for (const binding of bindings) {
          const marker = binding.isDefault ? "*" : " ";
          console.log(`${marker}\t${binding.id ?? ""}\t${binding.label ?? ""}\t${binding.towerUrl ?? ""}\t${binding.workspaceOwnerNpub ?? ""}`);
        }
      }
    }
    return;
  }

  if (command === "tower-binding-create") {
    if (!starterName) throw new Error("tower-binding-create requires --name <name>");
    if (!towerUrl) throw new Error("tower-binding-create requires --tower-url <url>");
    if (!workspaceOwnerNpub) throw new Error("tower-binding-create requires --workspace-owner-npub <npub>");
    const payload = await req<Record<string, unknown>>(
      "POST",
      "/api/wapps/tower-bindings",
      {
        label: starterName,
        towerUrl,
        workspaceOwnerNpub,
        userAlias,
        isDefault: makeDefault,
      },
    );
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      const binding = payload.binding as Record<string, unknown> | undefined;
      console.log(`Created WApp Tower binding: ${binding?.id ?? starterName}`);
    }
    return;
  }

  if (command === "starters-create") {
    if (!starterName) throw new Error("starters-create requires --name <name>");
    if (!gitUrl) throw new Error("starters-create requires --git-url <url>");
    const body: Record<string, unknown> = { name: starterName, gitUrl };
    if (webApp) body.webApp = true;
    const payload = await req<Record<string, unknown>>(
      "POST", "/api/admin/starter-projects", body,
    );
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Created starter: ${payload.id ?? starterName}`);
    }
    return;
  }

  if (command === "clone") {
    const repoUrl = appId; // positional[1] is the repo URL for clone
    if (!repoUrl) throw new Error("clone requires <repo-url>");
    const body: Record<string, unknown> = { url: repoUrl };
    if (directory) body.directory = directory;
    const payload = await req<Record<string, unknown>>(
      "POST", appsPath("/clone"), body,
    );
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Cloned: ${payload.root ?? payload.label ?? repoUrl}`);
    }
    return;
  }

  if (command === "cf-tunnel-upsert") {
    const hostname = appId;
    const targetServiceUrl = serviceUrl ?? secondArg;
    if (!hostname) throw new Error("cf-tunnel-upsert requires <hostname>");
    if (!targetServiceUrl) throw new Error("cf-tunnel-upsert requires <service-url>");
    const payload = await req<Record<string, unknown>>(
      "POST",
      "/api/cloudflare/tunnel-hostnames",
      { hostname, serviceUrl: targetServiceUrl },
    );
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Cloudflare Tunnel hostname configured: ${hostname} -> ${targetServiceUrl}`);
    }
    return;
  }

  if (command === "cf-tunnel-verify") {
    const hostname = appId;
    const targetServiceUrl = serviceUrl ?? secondArg;
    if (!hostname) throw new Error("cf-tunnel-verify requires <hostname>");
    if (!targetServiceUrl) throw new Error("cf-tunnel-verify requires <service-url>");
    const query = new URLSearchParams({ hostname, serviceUrl: targetServiceUrl });
    const payload = await req<Record<string, unknown>>(
      "GET",
      `/api/cloudflare/tunnel-hostnames?${query.toString()}`,
    );
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      const verification = payload.verification as Record<string, unknown> | undefined;
      const ok = verification?.ok ? "ok" : "not-ok";
      console.log(`Cloudflare Tunnel hostname verification: ${hostname} ${ok}`);
    }
    return;
  }

  if (command === "cf-tunnel-remove") {
    const hostname = appId;
    if (!hostname) throw new Error("cf-tunnel-remove requires <hostname>");
    const query = new URLSearchParams({ deleteDns: deleteDns ? "true" : "false" });
    const payload = await req<Record<string, unknown>>(
      "DELETE",
      `/api/cloudflare/tunnel-hostnames/${encodeURIComponent(hostname)}?${query.toString()}`,
    );
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Cloudflare Tunnel hostname removed: ${hostname}`);
    }
    return;
  }

  if (!appId) throw new Error(`Command "${command}" requires <app-id>`);

  if (command === "starters-delete") {
    await req("DELETE", `/api/admin/starter-projects/${encodeURIComponent(appId)}`);
    console.log(`Deleted starter: ${appId}`);
    return;
  }

  if (command === "tower-binding-default") {
    const payload = await req<Record<string, unknown>>(
      "PATCH",
      `/api/wapps/tower-bindings/${encodeURIComponent(appId)}`,
      { isDefault: true },
    );
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Selected default WApp Tower binding: ${appId}`);
    }
    return;
  }

  if (command === "wapp-publisher-repair") {
    const installationId = appId;
    const localPath = ownerNpub
      ? `/api/owners/${encodeURIComponent(ownerNpub)}/wapps/${encodeURIComponent(installationId)}`
      : `/api/wapps/${encodeURIComponent(installationId)}`;
    let local = await req<{ wapp?: Record<string, unknown> }>("GET", localPath);
    let wapp = local.wapp ?? local as Record<string, unknown>;
    const currentPublisherNpub = String(wapp.publisherNpub ?? "").trim();
    if (!currentPublisherNpub) throw new Error("WApp has no current publisher npub");

    if (!String(wapp.pendingPublisherNpub ?? "").trim()) {
      const staged = await req<{ wapp?: Record<string, unknown> }>(
        "POST",
        `${localPath}/rotate-publisher-key`,
        {
          confirmWappInstallationId: installationId,
          phase: "stage",
          appKeyMode: "generate",
        },
      );
      wapp = staged.wapp ?? staged as Record<string, unknown>;
    }

    const pendingPublisherNpub = String(wapp.pendingPublisherNpub ?? "").trim();
    const towerBinding = wapp.towerBinding as Record<string, unknown> | null | undefined;
    const towerUrl = String(towerBinding?.towerUrl ?? "").replace(/\/$/, "");
    const workspaceId = String(towerBinding?.workspaceId ?? "").trim();
    if (!pendingPublisherNpub) throw new Error("WApp publisher-key staging did not return a pending publisher npub");
    if (!towerUrl || !workspaceId) throw new Error("WApp Tower binding is missing towerUrl or workspaceId");

    const towerPath = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/wapp-publishing-grants/${encodeURIComponent(installationId)}`;
    const towerRequest = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const url = new URL(path, `${towerUrl}/`).toString();
      const authorization = botCrypto
        ? await buildBotCryptoAuthHeader(resolveCapabilityBrokerUrl(baseUrl), url, method, body)
        : buildAuthHeader(url, method, buildConfig(urlInput, keyInput).secretKey, body);
      const response = await fetch(url, {
        method,
        headers: {
          authorization,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const raw = await response.text();
      const payload = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      if (!response.ok) {
        const message = String(payload.code ?? payload.error ?? payload.message ?? response.statusText);
        throw new Error(`${response.status} ${message}`);
      }
      return payload as T;
    };

    const grantPayload = await towerRequest<{ grant?: Record<string, unknown> }>("GET", towerPath);
    const towerPublisherNpub = String(grantPayload.grant?.publisher_npub ?? "").trim();
    if (towerPublisherNpub === currentPublisherNpub) {
      await towerRequest(
        "POST",
        `${towerPath}/rotate`,
        {
          current_publisher_npub: currentPublisherNpub,
          new_publisher_npub: pendingPublisherNpub,
          nonce: crypto.randomUUID(),
          expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        },
      );
    } else if (towerPublisherNpub !== pendingPublisherNpub) {
      throw new Error(`Tower publisher identity drift: expected ${currentPublisherNpub} or ${pendingPublisherNpub}`);
    }

    const activated = await req<{ wapp?: Record<string, unknown>; rotation?: string }>(
      "POST",
      `${localPath}/rotate-publisher-key`,
      { confirmWappInstallationId: installationId, phase: "activate" },
    );
    if (asJson) {
      console.log(JSON.stringify(activated, null, 2));
    } else {
      console.log(`Repaired WApp publisher: ${installationId} -> ${String(activated.wapp?.publisherNpub ?? pendingPublisherNpub)}`);
    }
    return;
  }

  if (command === "status") {
    const payload = await req<Record<string, unknown>>(
      "GET", appsPath(`/${encodeURIComponent(appId)}`),
    );
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "domains") {
    const payload = await req<{ domains?: Array<Record<string, unknown>> }>(
      "GET", appsPath(`/${encodeURIComponent(appId)}/domains`),
    );
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      printDomains(payload);
    }
    return;
  }

  if (command === "domain-add") {
    const hostname = secondArg;
    if (!hostname) throw new Error("domain-add requires <hostname>");
    const body: Record<string, unknown> = { hostname };
    if (domainStatus) body.status = domainStatus;
    const payload = await req<Record<string, unknown>>(
      "POST",
      appsPath(`/${encodeURIComponent(appId)}/domains`),
      body,
    );
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Registered real DNS name: ${hostname} -> ${appId}`);
    }
    return;
  }

  if (command === "domain-verify") {
    const hostname = secondArg;
    if (!hostname) throw new Error("domain-verify requires <hostname>");
    const payload = await req<Record<string, unknown>>(
      "POST",
      appsPath(`/${encodeURIComponent(appId)}/domains/${encodeURIComponent(hostname)}/verify`),
    );
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Verified real DNS name: ${hostname} -> ${appId}`);
    }
    return;
  }

  if (command === "domain-remove") {
    const hostname = secondArg;
    if (!hostname) throw new Error("domain-remove requires <hostname>");
    const payload = await req<Record<string, unknown>>(
      "DELETE",
      appsPath(`/${encodeURIComponent(appId)}/domains/${encodeURIComponent(hostname)}`),
    );
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Removed real DNS name: ${hostname} -> ${appId}`);
    }
    return;
  }

  if (command === "register") {
    if (!directory) throw new Error("register requires --directory <path>");
    const body: Record<string, unknown> = { root: directory, label: appId };
    if (webApp) body.webApp = true;
    const payload = await req<Record<string, unknown>>(
      "POST", appsPath(),
      body,
    );
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Registered: ${appId}`);
    }
    return;
  }

  if (command === "unregister") {
    const payload = await req<Record<string, unknown>>(
      "DELETE", appsPath(`/${encodeURIComponent(appId)}`),
    );
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Unregistered: ${appId}`);
    }
    return;
  }

  // Action commands: start, stop, restart, build, setup
  const payload = await req<Record<string, unknown>>(
    "POST",
    appsPath(`/${encodeURIComponent(appId)}/actions`),
    { action: command },
  );
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    const app = payload.app as Record<string, unknown> | undefined;
    const { status, running } = resolveAppStatus(app);
    console.log(`${command} ok: ${appId} status=${status} running=${running ? "yes" : "no"}`);
  }
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});

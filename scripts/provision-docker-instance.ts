import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

interface ProvisionOptions {
  adminNpub: string;
  baseUrl: string;
  envPath: string | null;
  force: boolean;
  hostPort: number | null;
  instanceName: string | null;
  workspaceHostPath: string;
}

const DEFAULT_INSTANCE_PREFIX = "wingman";
const DEFAULT_CONTAINER_PORT = 3600;
const DEFAULT_AGENT_PORT_START = 3700;
const DEFAULT_AGENT_MAX = 10;

function parseArgs(argv: string[]): ProvisionOptions {
  const options: ProvisionOptions = {
    adminNpub: "",
    baseUrl: "",
    envPath: null,
    force: false,
    hostPort: null,
    instanceName: null,
    workspaceHostPath: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--force") {
      options.force = true;
    } else if (arg === "--admin-npub" && next) {
      options.adminNpub = next;
      index += 1;
    } else if (arg === "--base-url" && next) {
      options.baseUrl = next;
      index += 1;
    } else if (arg === "--env" && next) {
      options.envPath = next;
      index += 1;
    } else if (arg === "--host-port" && next) {
      options.hostPort = parsePort(next, "--host-port");
      index += 1;
    } else if (arg === "--instance-name" && next) {
      options.instanceName = next;
      index += 1;
    } else if (arg === "--workspace-host-path" && next) {
      options.workspaceHostPath = next;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  return options;
}

function parsePort(input: string, flagName: string): number {
  const value = Number.parseInt(input, 10);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${flagName} must be a TCP port between 1 and 65535`);
  }
  return value;
}

function printUsage(): void {
  console.log(`Usage: bun run docker:provision [options]

Options:
  --admin-npub <npub>       Required admin/operator npub to seed into the Docker env file
  --base-url <url>          Public Wingman URL, defaults to http://localhost:<host-port>
  --env <path>              Env file to write, defaults to .env.<instance-name>
  --force                   Overwrite an existing env file
  --host-port <port>        Host port to publish, defaults from instance number
  --instance-name <name>    Compose project/instance name, defaults to wingman-01+
  --workspace-host-path <path>
                            Host directory mounted at /workspace
`);
}

function validateOptions(options: ProvisionOptions): void {
  if (!options.adminNpub.trim()) {
    throw new Error("--admin-npub is required so the first operator whitelist is configured before Docker setup completes");
  }
}

function listComposeProjectNames(): Set<string> {
  const result = spawnSync("docker", ["compose", "ls", "--format", "json"], {
    encoding: "utf8",
    timeout: 5000,
  });

  if (result.status !== 0 || !result.stdout.trim()) {
    return new Set();
  }

  try {
    const parsed = JSON.parse(result.stdout) as Array<{ Name?: string }>;
    return new Set(parsed.map((entry) => entry.Name).filter((name): name is string => Boolean(name)));
  } catch {
    return new Set();
  }
}

function formatInstanceName(index: number): string {
  return `${DEFAULT_INSTANCE_PREFIX}-${String(index).padStart(2, "0")}`;
}

function pickInstanceName(existingNames: Set<string>): { name: string; index: number } {
  for (let index = 1; index < 1000; index += 1) {
    const candidate = formatInstanceName(index);
    if (!existingNames.has(candidate)) {
      return { name: candidate, index };
    }
  }
  throw new Error("Unable to find an available wingman-### instance name");
}

function extractInstanceIndex(name: string): number {
  const match = name.match(/-(\d+)$/);
  if (!match) {
    return 1;
  }
  const suffix = match[1] ?? "1";
  return Number.parseInt(suffix, 10) || 1;
}

function defaultWorkspaceHostPath(index: number): string {
  if (index === 1) {
    return join(homedir(), ".wm-ap");
  }
  return join(homedir(), `.wm-ap${String(index).padStart(2, "0")}`);
}

function resolveWorkspaceHostPath(input: string, index: number): string {
  const rawPath = input.trim() || defaultWorkspaceHostPath(index);
  if (rawPath === "~") {
    return homedir();
  }
  if (rawPath.startsWith("~/")) {
    return join(homedir(), rawPath.slice(2));
  }
  return rawPath;
}

function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/+$/, "");
  }
  return `https://${trimmed.replace(/\/+$/, "")}`;
}

function generateSecret(): string {
  return randomBytes(48).toString("base64url");
}

function quoteEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@,+-]*$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function buildEnvContent(values: Record<string, string>): string {
  const lines = [
    "# Generated by scripts/provision-docker-instance.ts",
    "# Local Bun uses .env. Docker instances use this file with docker compose --env-file.",
    "# Run docker compose --env-file <this-file> up -d, then docker compose --env-file <this-file> exec wingman bash for CLI login.",
    "",
  ];

  for (const [key, value] of Object.entries(values)) {
    lines.push(`${key}=${quoteEnvValue(value)}`);
  }

  return `${lines.join("\n")}\n`;
}

function readExistingSecret(envPath: string): string {
  if (!existsSync(envPath)) {
    return "";
  }

  const content = readFileSync(envPath, "utf8");
  const match = content.match(/^(?:WINGMAN_)?IDENTITY_SESSION_SECRET=(.*)$/m);
  return match?.[1]?.replace(/^["']|["']$/g, "").trim() ?? "";
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  validateOptions(options);

  const picked = options.instanceName
    ? { name: options.instanceName, index: extractInstanceIndex(options.instanceName) }
    : pickInstanceName(listComposeProjectNames());
  const envPath = options.envPath ?? `.env.${picked.name}`;

  if (existsSync(envPath) && !options.force) {
    throw new Error(`${envPath} already exists; pass --force to overwrite`);
  }

  const hostPort = options.hostPort ?? DEFAULT_CONTAINER_PORT + picked.index - 1;
  const baseUrl = normalizeBaseUrl(options.baseUrl || `http://localhost:${hostPort}`);
  const secret = readExistingSecret(envPath) || generateSecret();
  const secureCookies = baseUrl.startsWith("https://") ? "true" : "false";
  const workspaceHostPath = resolveWorkspaceHostPath(options.workspaceHostPath, picked.index);
  mkdirSync(workspaceHostPath, { recursive: true });
  chmodSync(workspaceHostPath, 0o777);

  const values: Record<string, string> = {
    COMPOSE_PROJECT_NAME: picked.name,
    WINGMAN_INSTANCE_NAME: picked.name,
    WINGMAN_IMAGE: "wingman-autopilot:local",
    WINGMAN_HOST_PORT: String(hostPort),
    WINGMAN_AGENT_PORTS: String(DEFAULT_AGENT_PORT_START),
    WINGMAN_AGENT_MAX: String(DEFAULT_AGENT_MAX),
    WINGMAN_DIRECTORY_DEF: "/workspace",
    WINGMAN_AGENT_DISPATCH_DIRECTORY: "/workspace",
    WINGMAN_FOLDERACCESS: "/workspace",
    WINGMAN_WORKSPACE_HOST_PATH: workspaceHostPath,
    WINGMAN_BASE_URL: baseUrl,
    WINGMAN_IDENTITY_COOKIE_SECURE: secureCookies,
    WINGMAN_APP_ROUTING: "path",
    WINGMAN_SUBDOMAIN_BASE_DOMAIN: "",
    WINGMAN_SUBDOMAIN_PROXY_ENABLED: "true",
    WINGMAN_AGENT_SPAWN_MODE: "bun",
    WINGMAN_AGENTAPI_ALLOWED_HOSTS: "localhost,127.0.0.1,[::1]",
    WINGMAN_DEFAULT_AGENT: "codex",
    WINGMAN_CODEX_CLI: "/usr/local/bin/codex",
    WINGMAN_CODEX_TRUSTED_WORKSPACE: "/workspace",
    WINGMAN_CLAUDE_CLI: "/usr/local/bin/claude",
    WINGMAN_GLOVES: "OFF",
    WINGMAN_GOOSE_CLI: "/usr/local/bin/goose",
    WINGMAN_OPENCODE_CLI: "/usr/local/bin/opencode",
    WINGMAN_GEMINI_CLI: "/usr/local/bin/gemini",
    WINGMAN_PI_CLI: "/usr/local/bin/pi",
    WINGMAN_IDENTITY_SESSION_SECRET: secret,
    WINGMAN_ADMIN_NPUB: options.adminNpub,
    WINGMAN_PRIV: "",
    WINGMAN_KEYTELEPORT_PRIVKEY: "",
    WINGMAN_KEYTELEPORT_WELCOME_PUBKEY: "",
    WINGMAN_KEYTELEPORT_WELCOME_URL: "https://welcome.nostr.com",
    WINGMAN_REGISTER: "false",
    WINGMAN_SHARED_AGENT_DISPATCH: "true",
    WINGMAN_SETUP_NONINTERACTIVE: "true",
  };

  writeFileSync(envPath, buildEnvContent(values), { mode: 0o600 });

  console.log(`Wrote ${envPath}`);
  console.log(`Instance: ${picked.name}`);
  console.log(`URL: ${baseUrl}`);
  console.log(`Workspace: ${workspaceHostPath} -> /workspace`);
  console.log(`Next: docker compose --env-file ${envPath} up -d`);
}

if (import.meta.main) {
  main();
}

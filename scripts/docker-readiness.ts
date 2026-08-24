import { access, constants, readFile, stat, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

type CheckStatus = "pass" | "warn" | "fail";

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

interface CommandSpec {
  name: string;
  command: string;
  args: string[];
}

interface AuthSpec {
  name: string;
  relativePaths: string[];
  envVars?: string[];
  validatesContent?: (relativePath: string, content: string) => boolean;
}

const expectedDirectories = [
  "/home/wingman",
  "/app/data",
  "/app/tmp",
  "/workspace",
];

const commandSpecs: CommandSpec[] = [
  { name: "Bun", command: "bun", args: ["--version"] },
  { name: "Node", command: "node", args: ["--version"] },
  { name: "npm", command: "npm", args: ["--version"] },
  { name: "git", command: "git", args: ["--version"] },
  { name: "bash", command: "bash", args: ["--version"] },
  { name: "bubblewrap", command: "bwrap", args: ["--version"] },
  { name: "make", command: "make", args: ["--version"] },
  { name: "gcc", command: "gcc", args: ["--version"] },
  { name: "agentapi", command: "/app/out/agentapi", args: ["--version"] },
  { name: "Codex CLI", command: process.env.CODEX_CLI || "/usr/local/bin/codex", args: ["--version"] },
  { name: "Claude CLI", command: process.env.CLAUDE_CLI || "/usr/local/bin/claude", args: ["--version"] },
  { name: "Goose CLI", command: process.env.GOOSE_CLI || "/usr/local/bin/goose", args: ["--version"] },
  { name: "Goose ACP", command: process.env.GOOSE_CLI || "/usr/local/bin/goose", args: ["acp", "--help"] },
  { name: "OpenCode CLI", command: process.env.OPENCODE_CLI || "/usr/local/bin/opencode", args: ["--version"] },
  { name: "Gemini CLI", command: process.env.GEMINI_CLI || "/usr/local/bin/gemini", args: ["--version"] },
  { name: "Pi CLI", command: process.env.PI_CLI || "/usr/local/bin/pi", args: ["--version"] },
];

const authSpecs: AuthSpec[] = [
  {
    name: "Codex auth",
    relativePaths: [".codex/auth.json", ".codex/config.toml"],
    envVars: ["OPENAI_API_KEY"],
  },
  {
    name: "Claude auth",
    relativePaths: [".claude/.credentials.json", ".claude.json", ".config/claude/credentials.json"],
    envVars: ["ANTHROPIC_API_KEY"],
  },
  {
    name: "Goose auth",
    relativePaths: [".config/goose/config.yaml", ".config/goose/profiles.yaml"],
    envVars: ["GOOSE_PROVIDER", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
    validatesContent: (relativePath, content) => {
      if (relativePath.endsWith("profiles.yaml")) {
        return content.trim().length > 2;
      }
      return /^GOOSE_PROVIDER:\s*\S+/m.test(content) || /^provider:\s*\S+/m.test(content);
    },
  },
  {
    name: "OpenCode auth",
    relativePaths: [".local/share/opencode/auth.json"],
    envVars: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN"],
  },
];

function firstLine(input: string): string {
  return input.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function runCommand(spec: CommandSpec): CheckResult {
  const result = spawnSync(spec.command, spec.args, {
    encoding: "utf8",
    timeout: 5000,
  });

  if (result.error) {
    return {
      name: spec.name,
      status: "fail",
      detail: result.error.message,
    };
  }

  if (result.status !== 0) {
    return {
      name: spec.name,
      status: "fail",
      detail: firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.status}`,
    };
  }

  return {
    name: spec.name,
    status: "pass",
    detail: firstLine(result.stdout) || firstLine(result.stderr) || "installed",
  };
}

async function directoryWritable(path: string): Promise<CheckResult> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) {
      return { name: path, status: "fail", detail: "not a directory" };
    }

    await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
    const probePath = join(path, `.wingman-write-check-${process.pid}`);
    await writeFile(probePath, "ok");
    await unlink(probePath);
    return { name: path, status: "pass", detail: "writable" };
  } catch (error) {
    return {
      name: path,
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

async function authFileMatches(spec: AuthSpec, relativePath: string, fullPath: string): Promise<boolean> {
  if (!await fileExists(fullPath)) {
    return false;
  }

  if (!spec.validatesContent) {
    return true;
  }

  const content = await readFile(fullPath, "utf8").catch(() => "");
  return spec.validatesContent(relativePath, content);
}

async function authCheck(spec: AuthSpec, home: string): Promise<CheckResult> {
  const envMatches = spec.envVars?.filter((envVar) => Boolean(process.env[envVar]?.trim())) ?? [];
  if (envMatches.length > 0) {
    return { name: spec.name, status: "pass", detail: `environment: ${envMatches.join(", ")}` };
  }

  const matches: string[] = [];
  for (const relativePath of spec.relativePaths) {
    const fullPath = join(home, relativePath);
    if (await authFileMatches(spec, relativePath, fullPath)) {
      matches.push(fullPath);
    }
  }

  if (matches.length > 0) {
    return { name: spec.name, status: "pass", detail: matches.join(", ") };
  }

  return {
    name: spec.name,
    status: "warn",
    detail: `not detected; run the CLI login flow inside the container shell`,
  };
}

function envCheck(name: string, value: string | undefined, required = false, sensitive = false): CheckResult {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length > 0) {
    return { name, status: "pass", detail: sensitive ? "set" : trimmed };
  }

  return {
    name,
    status: required ? "fail" : "warn",
    detail: "not set",
  };
}

export function buildConfigChecks(env: NodeJS.ProcessEnv, strictMode = false): CheckResult[] {
  return [
    envCheck("WINGMAN_INSTANCE_NAME", env.WINGMAN_INSTANCE_NAME),
    envCheck("WINGMAN_BASE_URL", env.WINGMAN_BASE_URL),
    envCheck("DIRECTORY_DEF", env.DIRECTORY_DEF, true),
    envCheck("FOLDERACCESS", env.FOLDERACCESS, true),
    envCheck("WINGMAN_WORKSPACE_HOST_PATH", env.WINGMAN_WORKSPACE_HOST_PATH),
    envCheck("WINGMAN_PRIV", env.WINGMAN_PRIV, false, true),
    envCheck("IDENTITY_SESSION_SECRET", env.IDENTITY_SESSION_SECRET, true, true),
    envCheck("IDENTITY_COOKIE_SECURE", env.IDENTITY_COOKIE_SECURE),
    envCheck("ADMIN_NPUB", env.ADMIN_NPUB, strictMode),
  ];
}

function printTable(title: string, checks: CheckResult[]): void {
  console.log(`\n${title}`);
  for (const check of checks) {
    const marker = check.status.toUpperCase().padEnd(4, " ");
    console.log(`${marker} ${check.name}: ${check.detail}`);
  }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const outputJson = args.has("--json");
  const strict = args.has("--strict");

  const commandChecks = commandSpecs.map(runCommand);
  const directoryChecks = await Promise.all(expectedDirectories.map(directoryWritable));
  const home = process.env.HOME?.trim() || "/home/wingman";
  const authChecks = await Promise.all(authSpecs.map((spec) => authCheck(spec, home)));
  const configChecks = buildConfigChecks(process.env, strict);

  const result = {
    ok: [...commandChecks, ...directoryChecks, ...configChecks].every((check) => check.status !== "fail"),
    strict,
    commandChecks,
    directoryChecks,
    authChecks,
    configChecks,
  };

  if (outputJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printTable("Installed tools", commandChecks);
    printTable("Writable volumes", directoryChecks);
    printTable("CLI authentication", authChecks);
    printTable("Wingman configuration", configChecks);
  }

  if (strict && !result.ok) {
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = new URL("..", import.meta.url).pathname;
const tempDirs: string[] = [];

function makeTempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "wingman-docker-provision-"));
  tempDirs.push(path);
  return path;
}

function runProvision(args: string[]) {
  return spawnSync("bun", ["run", "scripts/provision-docker-instance.ts", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function runProvisionFrom(cwd: string, args: string[]) {
  return spawnSync("bun", ["run", join(repoRoot, "scripts/provision-docker-instance.ts"), ...args], {
    cwd,
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("docker provisioning", () => {
  test("rejects missing admin npub", () => {
    const envPath = join(makeTempDir(), ".env");
    const result = runProvision(["--env", envPath, "--instance-name", "wingman-99"]);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("--admin-npub is required");
  });

  test("writes required admin npub into generated env", () => {
    const envPath = join(makeTempDir(), ".env");
    const result = runProvision([
      "--env",
      envPath,
      "--instance-name",
      "wingman-99",
      "--host-port",
      "3999",
      "--base-url",
      "https://wingman.example.test",
      "--admin-npub",
      "npub1operator",
    ]);

    expect(result.status).toBe(0);
    const content = readFileSync(envPath, "utf8");
    expect(content).toContain("WINGMAN_ADMIN_NPUB=npub1operator");
    expect(content).toContain("WINGMAN_IDENTITY_COOKIE_SECURE=true");
    expect(content).not.toContain("WINGMAN_CONTAINER_PORT=");
    expect(content).toContain("WINGMAN_CODEX_CLI=/usr/local/bin/codex");
    expect(content).toContain("WINGMAN_CODEX_TRUSTED_WORKSPACE=/workspace");
    expect(content).toContain("WINGMAN_GLOVES=OFF");
    expect(content).toContain(`WINGMAN_WORKSPACE_HOST_PATH=${join(homedir(), ".wm-ap99")}`);
    expect(content).toContain("WINGMAN_SUBDOMAIN_BASE_DOMAIN=");
    expect(content).toContain("WINGMAN_PI_CLI=/usr/local/bin/pi");
    expect(content).toContain("WINGMAN_PRIV=");
    expect(content).toContain("WINGMAN_KEYTELEPORT_PRIVKEY=");
    expect(content).toContain("WINGMAN_KEYTELEPORT_WELCOME_PUBKEY=");
    expect(content).toContain("WINGMAN_KEYTELEPORT_WELCOME_URL=https://welcome.nostr.com");
    expect(content).toContain("WINGMAN_REGISTER=false");
    expect(content).toContain("WINGMAN_SHARED_AGENT_DISPATCH=true");
    expect(content).toContain("WINGMAN_SETUP_NONINTERACTIVE=true");
  });

  test("normalizes bare public hostnames to https base URLs", () => {
    const envPath = join(makeTempDir(), ".env");
    const result = runProvision([
      "--env",
      envPath,
      "--instance-name",
      "wingman-99",
      "--host-port",
      "3999",
      "--base-url",
      "mw.runwingman.com",
      "--admin-npub",
      "npub1operator",
    ]);

    expect(result.status).toBe(0);
    const content = readFileSync(envPath, "utf8");
    expect(content).toContain("WINGMAN_BASE_URL=https://mw.runwingman.com");
    expect(content).toContain("WINGMAN_IDENTITY_COOKIE_SECURE=true");
  });

  test("defaults Docker env files to the selected instance name", () => {
    const cwd = makeTempDir();
    const result = runProvisionFrom(cwd, [
      "--instance-name",
      "wingman-42",
      "--admin-npub",
      "npub1operator",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Wrote .env.wingman-42");
    expect(result.stdout).toContain("docker compose --env-file .env.wingman-42 up -d");
    const content = readFileSync(join(cwd, ".env.wingman-42"), "utf8");
    expect(content).toContain("COMPOSE_PROJECT_NAME=wingman-42");
  });

  test("disables secure cookies for local http base URLs", () => {
    const envPath = join(makeTempDir(), ".env");
    const result = runProvision([
      "--env",
      envPath,
      "--instance-name",
      "wingman-99",
      "--host-port",
      "3999",
      "--base-url",
      "http://localhost:3999",
      "--admin-npub",
      "npub1operator",
    ]);

    expect(result.status).toBe(0);
    const content = readFileSync(envPath, "utf8");
    expect(content).toContain("WINGMAN_IDENTITY_COOKIE_SECURE=false");
  });

  test("allows overriding the host workspace directory", () => {
    const envPath = join(makeTempDir(), ".env");
    const workspacePath = join(makeTempDir(), "workspace");
    const result = runProvision([
      "--env",
      envPath,
      "--instance-name",
      "wingman-99",
      "--workspace-host-path",
      workspacePath,
      "--admin-npub",
      "npub1operator",
    ]);

    expect(result.status).toBe(0);
    const content = readFileSync(envPath, "utf8");
    expect(content).toContain(`WINGMAN_WORKSPACE_HOST_PATH=${workspacePath}`);
  });

  test("makes the host workspace writable by the container user", () => {
    const envPath = join(makeTempDir(), ".env");
    const workspacePath = join(makeTempDir(), "workspace");
    const result = runProvision([
      "--env",
      envPath,
      "--instance-name",
      "wingman-99",
      "--workspace-host-path",
      workspacePath,
      "--admin-npub",
      "npub1operator",
    ]);

    expect(result.status).toBe(0);
    expect(statSync(workspacePath).mode & 0o777).toBe(0o777);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { loadConfig, resolveAgentLaunchConfig } from "./config";

Bun.env.WINGMAN_DISABLE_INSTANCE_SETTINGS = "1";
process.env.WINGMAN_DISABLE_INSTANCE_SETTINGS = "1";

const ENV_KEYS = [
  "AGENT_MODE",
  "AGENT_CLI_AUTOUPDATE",
  "AGENT_SPAWN_MODE",
  "AGENT_STATUS_POLL_TIMEOUT_MS",
  "AGENT_TMUX_SESSION",
  "AGENTAPI_BIN",
  "APP_ROUTING",
  "CODEX_CLI",
  "DEFAULT_AGENT",
  "DIRECTORY_DEF",
  "AGENT_DISPATCH_DIRECTORY",
  "FOLDERACCESS",
  "GLOVES",
  "MAPLE_ACP_CLI",
  "PI_CLI",
  "SUBDOMAIN_BASE_DOMAIN",
  "SUBDOMAIN_PROXY_ENABLED",
  "WINGMAN_APP_ROUTING",
  "WINGMAN_AGENT_DISPATCH_DIRECTORY",
  "WINGMAN_BASE_URL",
  "WINGMAN_SUBDOMAIN_BASE_DOMAIN",
  "WINGMAN_SUBDOMAIN_PROXY_ENABLED",
  "WINGMAN_DISABLE_INSTANCE_SETTINGS",
] as const;

const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, Bun.env[key]]),
);

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete Bun.env[key];
      delete process.env[key];
    } else {
      Bun.env[key] = value;
      process.env[key] = value;
    }
  }
}

function applyEnv(overrides: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>): void {
  restoreEnv();
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete Bun.env[key];
      delete process.env[key];
    } else {
      Bun.env[key] = value;
      process.env[key] = value;
    }
  }
}

afterEach(() => {
  restoreEnv();
});

describe("resolveAgentLaunchConfig", () => {
  test("defaults to the standard agentapi binary and bun spawn mode", () => {
    const result = resolveAgentLaunchConfig({});

    expect(result.agentApiBinarySource).toBe("default");
    expect(result.agentApiBinary.endsWith(join("out", "agentapi"))).toBe(true);
    expect(result.agentSpawnMode).toBe("bun");
    expect(result.agentSpawnModeSource).toBe("default");
    expect(result.warnings).toEqual([]);
  });

  test("ignores the deprecated AGENT_MODE=pm2 process-preservation mode", () => {
    const result = resolveAgentLaunchConfig({ AGENT_MODE: "pm2" });

    expect(result.agentApiBinarySource).toBe("default");
    expect(result.agentApiBinary.endsWith(join("out", "agentapi"))).toBe(true);
    expect(result.agentSpawnMode).toBe("bun");
    expect(result.agentSpawnModeSource).toBe("default");
    expect(result.warnings).toContain("AGENT_MODE=pm2 is deprecated and ignored; agent sessions use direct Bun spawning.");
  });

  test("ignores the deprecated AGENT_MODE=tmux process-preservation mode", () => {
    const result = resolveAgentLaunchConfig({ AGENT_MODE: "tmux" });

    expect(result.agentApiBinarySource).toBe("default");
    expect(result.agentApiBinary.endsWith(join("out", "agentapi"))).toBe(true);
    expect(result.agentSpawnMode).toBe("bun");
    expect(result.agentSpawnModeSource).toBe("default");
    expect(result.warnings).toContain(
      "AGENT_MODE=tmux is deprecated and ignored; agent sessions use direct Bun spawning.",
    );
  });

  test("prefers AGENT_SPAWN_MODE over the deprecated AGENT_MODE=pm2 alias", () => {
    const result = resolveAgentLaunchConfig({
      AGENT_MODE: "pm2",
      AGENT_SPAWN_MODE: "bun",
    });

    expect(result.agentSpawnMode).toBe("bun");
    expect(result.agentSpawnModeSource).toBe("agent_spawn_mode");
    expect(result.warnings).toContain(
      "AGENT_MODE=pm2 is deprecated and ignored; agent sessions use direct Bun spawning.",
    );
  });

  test("ignores AGENT_SPAWN_MODE=tmux and keeps direct Bun spawning", () => {
    const result = resolveAgentLaunchConfig({ AGENT_SPAWN_MODE: "tmux" });

    expect(result.agentApiBinarySource).toBe("default");
    expect(result.agentApiBinary.endsWith(join("out", "agentapi"))).toBe(true);
    expect(result.agentSpawnMode).toBe("bun");
    expect(result.agentSpawnModeSource).toBe("agent_spawn_mode");
    expect(result.warnings).toContain(
      "AGENT_SPAWN_MODE=tmux is no longer supported for agent sessions; using direct Bun spawning.",
    );
  });

  test("keeps AGENTAPI_BIN independent from the deprecated AGENT_MODE=tmux alias", () => {
    const result = resolveAgentLaunchConfig({
      AGENT_MODE: "tmux",
      AGENTAPI_BIN: " /tmp/custom-agentapi ",
    });

    expect(result.agentApiBinary).toBe("/tmp/custom-agentapi");
    expect(result.agentApiBinarySource).toBe("agentapi_bin");
    expect(result.agentSpawnMode).toBe("bun");
    expect(result.warnings).toContain(
      "AGENT_MODE=tmux is deprecated and ignored; agent sessions use direct Bun spawning.",
    );
  });
});

describe("loadConfig", () => {
  test("distinguishes the localhost default from an explicitly configured public base URL", () => {
    applyEnv({ WINGMAN_BASE_URL: undefined });
    const defaulted = loadConfig();
    expect(defaulted.baseUrl).toStartWith("http://localhost:");
    expect(defaulted.baseUrlConfigured).toBe(false);

    applyEnv({ WINGMAN_BASE_URL: " https://wingman.acme.co " });
    const configured = loadConfig();
    expect(configured.baseUrl).toBe("https://wingman.acme.co");
    expect(configured.baseUrlConfigured).toBe(true);
  });

  test("exposes all Maple Desktop models with its Desktop-owned default first", () => {
    applyEnv({ MAPLE_ACP_CLI: undefined });
    const config = loadConfig();
    const command = config.agents.maple.command({ agent: "maple", config, port: 3701 });

    expect(config.agents.maple.label).toBe("Maple Desktop");
    expect(config.agents.maple.modelOptions).toEqual([
      "DeepSeek V4 Flash",
      "OpenAI GPT-OSS 120B",
      "Gemma 4 31B",
      "Kimi K3",
      "Kimi K2.6",
      "GLM 5.2",
      "Llama 3.3 70B",
    ]);
    expect(command.at(-1)).toBe("/Applications/Maple.app/Contents/MacOS/maple");
  });

  test("builds agent commands from the resolved AGENTAPI_BIN path", () => {
    applyEnv({
      AGENTAPI_BIN: "/tmp/custom-agentapi",
      CODEX_CLI: undefined,
      AGENT_MODE: undefined,
      AGENT_SPAWN_MODE: undefined,
      GLOVES: undefined,
    });

    const config = loadConfig();
    const command = config.agents.codex.command({
      agent: "codex",
      config,
      port: 3701,
    });

    expect(command[0]).toBe("/tmp/custom-agentapi");
    expect(config.agentSpawnMode).toBe("bun");
  });

  test("keeps the tmux session name only as compatibility configuration", () => {
    applyEnv({
      AGENT_SPAWN_MODE: "tmux",
      AGENT_TMUX_SESSION: "custom-agents",
      AGENT_MODE: undefined,
      AGENTAPI_BIN: "/tmp/custom-agentapi",
      GLOVES: undefined,
    });

    const config = loadConfig();

    expect(config.agentSpawnMode).toBe("bun");
    expect(config.agentTmuxSession).toBe("custom-agents");
  });

  test("defaults to codex when DEFAULT_AGENT is not set", () => {
    applyEnv({
      DEFAULT_AGENT: undefined,
      AGENTAPI_BIN: "/tmp/custom-agentapi",
      CODEX_CLI: undefined,
      AGENT_MODE: undefined,
      AGENT_SPAWN_MODE: undefined,
      GLOVES: undefined,
    });

    const config = loadConfig();

    expect(config.defaultAgent).toBe("codex");
  });

  test("uses DIRECTORY_DEF as the default dispatch agent directory", () => {
    applyEnv({
      AGENTAPI_BIN: "/tmp/custom-agentapi",
      DIRECTORY_DEF: "~/code",
      AGENT_DISPATCH_DIRECTORY: undefined,
      WINGMAN_AGENT_DISPATCH_DIRECTORY: undefined,
      FOLDERACCESS: undefined,
      AGENT_MODE: undefined,
      AGENT_SPAWN_MODE: undefined,
      GLOVES: undefined,
    });

    const config = loadConfig();

    expect(config.agentDispatchWorkingDirectory).toBe(join(Bun.env.HOME ?? "~", "code"));
    expect(config.allowedDirectories).toContain(config.agentDispatchWorkingDirectory);
  });

  test("accepts an explicit dispatch agent directory", () => {
    applyEnv({
      AGENTAPI_BIN: "/tmp/custom-agentapi",
      DIRECTORY_DEF: "~/code",
      AGENT_DISPATCH_DIRECTORY: "~/wingmen/agent-workspace",
      WINGMAN_AGENT_DISPATCH_DIRECTORY: undefined,
      FOLDERACCESS: undefined,
      AGENT_MODE: undefined,
      AGENT_SPAWN_MODE: undefined,
      GLOVES: undefined,
    });

    const config = loadConfig();

    expect(config.agentDispatchWorkingDirectory).toBe(join(Bun.env.HOME ?? "~", "wingmen", "agent-workspace"));
    expect(config.allowedDirectories).toContain(config.agentDispatchWorkingDirectory);
  });

  test("passes explicit agentapi type flags for command-backed agents", () => {
    applyEnv({
      AGENTAPI_BIN: "/tmp/custom-agentapi",
      CODEX_CLI: undefined,
      AGENT_MODE: undefined,
      AGENT_SPAWN_MODE: undefined,
      GLOVES: undefined,
    });

    const config = loadConfig();
    const claudeCommand = config.agents.claude.command({ agent: "claude", config, port: 3701 });
    const gooseCommand = config.agents.goose.command({ agent: "goose", config, port: 3702 });
    const geminiCommand = config.agents.gemini.command({ agent: "gemini", config, port: 3703 });
    const openCodeCommand = config.agents.opencode.command({ agent: "opencode", config, port: 3704 });

    expect(claudeCommand).toContain("--type=claude");
    expect(gooseCommand).toContain("--type=goose");
    expect(geminiCommand).toContain("--type=gemini");
    expect(openCodeCommand).toContain("--type=opencode");
  });

  test("exposes Claude model aliases for session launch overrides", () => {
    applyEnv({
      AGENTAPI_BIN: "/tmp/custom-agentapi",
      AGENT_MODE: undefined,
      AGENT_SPAWN_MODE: undefined,
      GLOVES: undefined,
    });

    const config = loadConfig();

    expect(config.agents.claude.modelOptions).toEqual([
      "default",
      "opus",
      "sonnet",
      "sonnet[1m]",
      "haiku",
    ]);
  });

  test("exposes the OpenRouter Kimi K3 model for Goose and OpenCode", () => {
    applyEnv({
      AGENTAPI_BIN: "/tmp/custom-agentapi",
      AGENT_MODE: undefined,
      AGENT_SPAWN_MODE: undefined,
      GLOVES: undefined,
    });

    const config = loadConfig();

    expect(config.agents.goose.modelOptions).toContain("openrouter/moonshotai/kimi-k3");
    expect(config.agents.opencode.modelOptions).toContain("openrouter/moonshotai/kimi-k3");
  });

  test("uses GLOVES=OFF as the single approval bypass for Codex and Claude", () => {
    applyEnv({
      AGENTAPI_BIN: "/tmp/custom-agentapi",
      AGENT_CLI_AUTOUPDATE: "true",
      CODEX_CLI: undefined,
      AGENT_MODE: undefined,
      AGENT_SPAWN_MODE: undefined,
      GLOVES: "OFF",
    });

    const config = loadConfig();
    const codexCommand = config.agents.codex.command({ agent: "codex", config, port: 3701 });
    const claudeCommand = config.agents.claude.command({ agent: "claude", config, port: 3702 });

    expect(codexCommand).toEqual([
      "/tmp/custom-agentapi",
      "server",
      "--port",
      "3701",
      "--allowed-origins",
      "http://127.0.0.1,http://localhost",
      "--allowed-hosts",
      "localhost,127.0.0.1,[::1]",
      "--type=codex",
      "--",
      "codex",
      "--yolo",
    ]);
    expect(claudeCommand.slice(-3)).toEqual(["--", "claude", "--dangerously-skip-permissions"]);
  });

  test("disables Codex and Claude background update checks by default", () => {
    applyEnv({
      AGENTAPI_BIN: "/tmp/custom-agentapi",
      AGENT_CLI_AUTOUPDATE: undefined,
      AGENT_MODE: undefined,
      AGENT_SPAWN_MODE: undefined,
      GLOVES: undefined,
    });

    const config = loadConfig();

    expect(config.agents.codex.env).toEqual({
      NO_UPDATE_NOTIFIER: "1",
      npm_config_update_notifier: "false",
    });
    expect(config.agents.claude.env).toEqual({
      DISABLE_AUTOUPDATER: "1",
    });

    const codexCommand = config.agents.codex.command({ agent: "codex", config, port: 3701 });
    expect(codexCommand.slice(-2)).toEqual([
      "-c",
      "check_for_update_on_startup=false",
    ]);
  });

  test("allows explicit Codex and Claude CLI auto-update opt-in", () => {
    applyEnv({
      AGENTAPI_BIN: "/tmp/custom-agentapi",
      AGENT_CLI_AUTOUPDATE: "true",
      AGENT_MODE: undefined,
      AGENT_SPAWN_MODE: undefined,
      GLOVES: undefined,
    });

    const config = loadConfig();

    expect(config.agents.codex.env).toEqual({});
    expect(config.agents.claude.env).toEqual({});

    const codexCommand = config.agents.codex.command({ agent: "codex", config, port: 3701 });
    expect(codexCommand).not.toContain("check_for_update_on_startup=false");
  });

  test("accepts pi as a configured default agent and launcher target", () => {
    applyEnv({
      DEFAULT_AGENT: "pi",
      PI_CLI: "/opt/bin/pi",
      AGENTAPI_BIN: "/tmp/custom-agentapi",
      CODEX_CLI: undefined,
      AGENT_MODE: undefined,
      AGENT_SPAWN_MODE: undefined,
      GLOVES: undefined,
    });

    const config = loadConfig();
    const command = config.agents.pi.command({
      agent: "pi",
      config,
      port: 3701,
    });

    expect(config.defaultAgent).toBe("pi");
    expect(command[0]).toBe("/tmp/custom-agentapi");
    expect(command.slice(-2)).toEqual(["--", "/opt/bin/pi"]);
  });

  test("defaults status polling to a short local request timeout", () => {
    applyEnv({
      AGENT_STATUS_POLL_TIMEOUT_MS: undefined,
    });

    const config = loadConfig();

    expect(config.agentStatusPollTimeoutMs).toBe(1000);
  });

  test("allows status polling timeout override", () => {
    applyEnv({
      AGENT_STATUS_POLL_TIMEOUT_MS: "2500",
    });

    const config = loadConfig();

    expect(config.agentStatusPollTimeoutMs).toBe(2500);
  });

  test("uses Wingman-prefixed app routing settings over Docker defaults", () => {
    applyEnv({
      APP_ROUTING: "path",
      SUBDOMAIN_BASE_DOMAIN: undefined,
      SUBDOMAIN_PROXY_ENABLED: undefined,
      WINGMAN_APP_ROUTING: "subdomain",
      WINGMAN_SUBDOMAIN_BASE_DOMAIN: "agent.example.invalid",
      WINGMAN_SUBDOMAIN_PROXY_ENABLED: "true",
    });

    const config = loadConfig();

    expect(config.appRoutingMode).toBe("subdomain");
    expect(config.subdomainBaseDomain).toBe("agent.example.invalid");
    expect(config.subdomainProxyEnabled).toBe(true);
  });
});

/**
 * MCP Config Injector
 *
 * Writes per-agent MCP configuration so agents discover the Wingman MCP
 * server on startup. Each agent type has its own config mechanism:
 *
 *   Claude  → strict, session-private runtime config
 *   Goose   → config.yaml extension entry
 *   OpenCode → ~/.config/opencode/opencode.json mcp entry
 *
 * Called from process-manager before spawning the agent process.
 */

import { join, resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as yaml from "js-yaml";

import type { AgentType, WingmanConfig } from "../config";
import {
  buildClaudeWingmanServer,
  buildGooseWingmanExtension,
  buildOpenCodeWingmanMcp,
  removeClaudeWingmanServer,
  removeGooseWingmanExtension,
  removeOpenCodeWingmanMcp,
  upsertClaudeWingmanServer,
  upsertGooseWingmanExtension,
  upsertOpenCodeWingmanMcp,
} from "./mcp-config-helpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpInjectionContext {
  sessionId: string;
  agent: AgentType;
  workingDirectory: string;
  config: WingmanConfig;
  /** Shared Wingman bot identity. */
  wingmanNpub?: string;
  botPubkeyHex?: string;
  botNpub?: string;
  /** Requesting operator npub, used for audit and owner-scoped data. */
  userNpub?: string;
  /** Opaque, short-lived session capability. Inherited by MCP; never written into MCP config. */
  capabilityToken?: string;
}

export interface McpInjectionResult {
  /** Additional env vars to pass to the agent process. */
  env: Record<string, string>;
  /** Additional CLI args to append when launching the agent process. */
  commandArgs?: string[];
  /**
   * Structured Codex `--config` overrides, equivalent to `commandArgs` but in
   * the shape `@openai/codex-sdk` expects via `Codex({ config })`. Used by the
   * native Codex SDK adapter, which has no spawned CLI to receive `-c` args.
   */
  codexConfig?: Record<string, unknown>;
  /** Files modified by injection — cleanup will remove our entry only. */
  cleanupFiles: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const IDENTITY_KEYS = ["WINGMAN_BROKER_URL", "WINGMAN_NPUB", "BOT_PUBKEY_HEX", "BOT_NPUB", "USER_NPUB"] as const;

/** Extract broker/identity session env vars from baseEnv (only those that are set). */
export function pickIdentityEnv(env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of IDENTITY_KEYS) {
    if (env[key]) result[key] = env[key];
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write MCP configuration for the given agent session.
 * Returns extra env vars and a list of files to clean up later.
 */
export async function injectMcpConfig(
  ctx: McpInjectionContext,
): Promise<McpInjectionResult> {
  // Use the same canonical URL that the server's NIP-98 verifier uses. Hosted
  // instances may listen locally while authenticating as their public origin.
  const wingmanUrl = ctx.config.baseUrl.trim().replace(/\/$/, "");
  const mcpServerPath = resolve(
    dirname(import.meta.url.replace("file://", "")),
    "../mcp/stdio-server.ts",
  );

  const baseEnv: Record<string, string> = {
    WINGMAN_URL: wingmanUrl,
    // Bearer capabilities never need to traverse the public/reverse-proxied
    // origin. Signing clients use this host-local endpoint for the broker and
    // keep WINGMAN_URL as the canonical NIP-98 request target.
    WINGMAN_BROKER_URL: `http://127.0.0.1:${ctx.config.port}`,
    // Native ACP/SDK transports launch inside the Autopilot host process
    // instead of through buildAgentProcessEnv(). Bind their process and shell
    // commands to the same session identity as the scoped capability below.
    SESSION_ID: ctx.sessionId,
  };

  if (ctx.capabilityToken) {
    baseEnv.WINGMAN_CAPABILITY = ctx.capabilityToken;
  }

  // Pass bot identity env vars when available
  if (ctx.wingmanNpub) {
    baseEnv.WINGMAN_NPUB = ctx.wingmanNpub;
  }
  if (ctx.botPubkeyHex) {
    baseEnv.BOT_PUBKEY_HEX = ctx.botPubkeyHex;
  }
  if (ctx.botNpub) {
    baseEnv.BOT_NPUB = ctx.botNpub;
  }
  if (ctx.userNpub) {
    baseEnv.USER_NPUB = ctx.userNpub;
  }

  switch (ctx.agent) {
    case "codex":
      return injectCodex(ctx, mcpServerPath, baseEnv);
    case "claude":
      return injectClaude(ctx, mcpServerPath, baseEnv);
    case "goose":
      return injectGoose(ctx, mcpServerPath, baseEnv);
    case "opencode":
      return injectOpenCode(ctx, mcpServerPath, baseEnv);
    default:
      // Other agents: just pass env vars. The stdio server path is
      // available if the agent supports MCP via environment config.
      return {
        env: {
          ...baseEnv,
          WINGMAN_MCP_SERVER: mcpServerPath,
        },
        cleanupFiles: [],
      };
  }
}

/**
 * Remove the "wingman" MCP server entry from config files created during
 * injection. Preserves any other user-defined MCP servers.
 */
export async function cleanupMcpConfig(files: string[]): Promise<void> {
  for (const filePath of files) {
    try {
      if (!existsSync(filePath)) continue;

      if (filePath.startsWith(`${MCP_RUNTIME_ROOT}/`)) {
        await rm(dirname(filePath), { recursive: true, force: true });
        continue;
      }

      const file = Bun.file(filePath);
      
      if (filePath.endsWith('.json')) {
        // Handle JSON config files (Claude/OpenCode)
        const config = await file.json() as Record<string, unknown>;
        const claudeResult = removeClaudeWingmanServer(config);
        if (claudeResult.changed) {
          if (claudeResult.shouldDeleteFile) {
            const { unlink } = await import("node:fs/promises");
            await unlink(filePath);
          } else {
            await Bun.write(filePath, JSON.stringify(claudeResult.config, null, 2) + "\n");
          }
          continue;
        }

        const opencodeResult = removeOpenCodeWingmanMcp(config);
        if (opencodeResult.changed) {
          await Bun.write(filePath, JSON.stringify(opencodeResult.config, null, 2) + "\n");
        }
      } else if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
        // Handle YAML config files (Goose)
        const yamlContent = await file.text();
        const parsedConfig = yaml.load(yamlContent) as Record<string, unknown> | null;
        const config = parsedConfig ?? {};
        const result = removeGooseWingmanExtension(config);
        if (result.changed) {
          // Write back the updated config
          const yamlOutput = yaml.dump(result.config, {
            indent: 2,
            lineWidth: -1,
            noRefs: true,
          });
          await Bun.write(filePath, yamlOutput);
        }
      }
    } catch {
      // File may already be gone or corrupted — ignore
    }
  }
}

const MCP_RUNTIME_ROOT = resolve(import.meta.dir, "../../data/runtime/mcp-sessions");
const STALE_MCP_RUNTIME_MS = 24 * 60 * 60 * 1000;

export async function cleanupStaleMcpRuntime(now = Date.now()): Promise<void> {
  if (!existsSync(MCP_RUNTIME_ROOT)) return;
  for (const name of await readdir(MCP_RUNTIME_ROOT)) {
    const path = join(MCP_RUNTIME_ROOT, name);
    const info = await stat(path);
    if (info.isDirectory() && now - info.mtimeMs > STALE_MCP_RUNTIME_MS) {
      await rm(path, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Agent-specific injectors
// ---------------------------------------------------------------------------

/**
 * Claude receives an exclusive session-private config. Repository `.mcp.json`
 * is neither read nor written, and strict mode prevents Claude from loading it.
 */
async function injectClaude(
  ctx: McpInjectionContext,
  mcpServerPath: string,
  baseEnv: Record<string, string>,
): Promise<McpInjectionResult> {
  await cleanupStaleMcpRuntime();
  const sessionRuntimeDir = join(MCP_RUNTIME_ROOT, ctx.sessionId);
  const mcpConfigPath = join(sessionRuntimeDir, "mcp.json");
  const identityEnv = pickIdentityEnv(baseEnv);
  const wingmanServer = buildClaudeWingmanServer(
    mcpServerPath,
    baseEnv.WINGMAN_URL!,
    ctx.sessionId,
    identityEnv,
  );

  const config = upsertClaudeWingmanServer({}, wingmanServer);
  await mkdir(sessionRuntimeDir, { recursive: true, mode: 0o700 });
  await chmod(sessionRuntimeDir, 0o700);
  await writeFile(mcpConfigPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await chmod(mcpConfigPath, 0o600);

  console.log(`[mcp-injector] Wrote Claude MCP config: ${mcpConfigPath}`);

  return {
    env: baseEnv,
    commandArgs: ["--mcp-config", mcpConfigPath, "--strict-mcp-config"],
    cleanupFiles: [mcpConfigPath],
  };
}

/**
 * Codex supports MCP server configuration via CLI config overrides.
 * We inject a wingman stdio server entry with `-c` flags so each
 * session gets the right SESSION_ID without mutating global user config.
 */
function injectCodex(
  ctx: McpInjectionContext,
  mcpServerPath: string,
  baseEnv: Record<string, string>,
): McpInjectionResult {
  const escapeTomlString = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const identityEnv = pickIdentityEnv(baseEnv);

  // Single source of truth for the wingman MCP server's env table, reused by
  // both the CLI `-c` overrides (agentapi path) and the structured config
  // object (native Codex SDK path).
  const wingmanMcpEnv: Record<string, string> = {
    WINGMAN_URL: baseEnv.WINGMAN_URL!,
    SESSION_ID: ctx.sessionId,
    ...identityEnv,
  };

  const codexEnvInlineTable = `{ ${Object.entries(wingmanMcpEnv)
    .map(([k, v]) => `${k} = "${escapeTomlString(v)}"`)
    .join(", ")} }`;

  const commandArgs = [
    "-c",
    'mcp_servers.wingman.command="bun"',
    "-c",
    `mcp_servers.wingman.args=${JSON.stringify(["run", mcpServerPath])}`,
    "-c",
    `mcp_servers.wingman.env=${codexEnvInlineTable}`,
    "-c",
    'mcp_servers.wingman.env_vars=["WINGMAN_CAPABILITY"]',
  ];

  const codexConfig = {
    mcp_servers: {
      wingman: {
        command: "bun",
        args: ["run", mcpServerPath],
        env: wingmanMcpEnv,
        env_vars: ["WINGMAN_CAPABILITY"],
      },
    },
  };

  return { env: baseEnv, commandArgs, codexConfig, cleanupFiles: [] };
}

/**
 * Goose discovers MCP servers from ~/.config/goose/config.yaml extensions.
 * We merge a "wingman" extension entry into the existing config.
 */
async function injectGoose(
  ctx: McpInjectionContext,
  mcpServerPath: string,
  baseEnv: Record<string, string>,
): Promise<McpInjectionResult> {
  const gooseConfigDir = join(homedir(), ".config", "goose");
  const gooseConfigPath = join(gooseConfigDir, "config.yaml");
  const identityEnv = pickIdentityEnv(baseEnv);
  const wingmanExtension = buildGooseWingmanExtension(
    mcpServerPath,
    baseEnv.WINGMAN_URL!,
    ctx.sessionId,
    identityEnv,
  );

  // Merge into existing config.yaml if present
  let existingConfig: Record<string, unknown> = {};
  if (existsSync(gooseConfigPath)) {
    try {
      const file = Bun.file(gooseConfigPath);
      const yamlContent = await file.text();
      existingConfig = (yaml.load(yamlContent) as Record<string, unknown> | null) ?? {};
    } catch {
      // Corrupted file — start fresh
    }
  }

  const config = upsertGooseWingmanExtension(existingConfig, wingmanExtension);

  // Write back to config file
  const yamlOutput = yaml.dump(config, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
  });
  
  // Ensure config directory exists
  if (!existsSync(gooseConfigDir)) {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(gooseConfigDir, { recursive: true });
  }

  await Bun.write(gooseConfigPath, yamlOutput);

  console.log(`[mcp-injector] Wrote Goose MCP config: ${gooseConfigPath}`);

  return { env: baseEnv, cleanupFiles: [gooseConfigPath] };
}

/**
 * OpenCode discovers MCP servers from ~/.config/opencode/opencode.json mcp entries.
 * We merge a "wingman" local MCP entry into the existing config.
 */
async function injectOpenCode(
  ctx: McpInjectionContext,
  mcpServerPath: string,
  baseEnv: Record<string, string>,
): Promise<McpInjectionResult> {
  const opencodeConfigDir = join(homedir(), ".config", "opencode");
  const opencodeConfigPath = join(opencodeConfigDir, "opencode.json");
  const identityEnv = pickIdentityEnv(baseEnv);
  const wingmanMcp = buildOpenCodeWingmanMcp(
    mcpServerPath,
    baseEnv.WINGMAN_URL!,
    ctx.sessionId,
    identityEnv,
  );

  let existingConfig: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
  };
  if (existsSync(opencodeConfigPath)) {
    try {
      const file = Bun.file(opencodeConfigPath);
      existingConfig = await file.json();
    } catch {
      // Corrupted file — start fresh
    }
  }

  const config = upsertOpenCodeWingmanMcp(existingConfig, wingmanMcp);

  if (!existsSync(opencodeConfigDir)) {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(opencodeConfigDir, { recursive: true });
  }

  await Bun.write(opencodeConfigPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`[mcp-injector] Wrote OpenCode MCP config: ${opencodeConfigPath}`);

  return { env: baseEnv, cleanupFiles: [opencodeConfigPath] };
}

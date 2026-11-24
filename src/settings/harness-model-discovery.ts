import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildInheritedAgentEnvironment } from "../agents/agent-environment";
import { instanceSettingsService } from "./instance-settings-service";
import type { CliModelHarness } from "./harness-models";

/**
 * Reads local Claude/Codex catalogues and the authenticated Antigravity CLI
 * catalogue. Discovery failures leave saved lists unchanged.
 */

export interface DiscoveredHarnessModels {
  harness: CliModelHarness;
  models: string[];
  /** File the list was read from. */
  source: string;
  /** When the CLI last fetched its catalogue, if recorded. */
  fetchedAt: string | null;
}

type DiscoveryEnv = Record<string, string | undefined>;

export async function discoverHarnessModels(
  harness: CliModelHarness,
  env: DiscoveryEnv = process.env,
): Promise<DiscoveredHarnessModels> {
  if (harness === "antigravity") return discoverAntigravityModels(env);
  return harness === "codex" ? discoverCodexModels(env) : discoverClaudeModels(env);
}

export async function discoverCodexModels(env: DiscoveryEnv = process.env): Promise<DiscoveredHarnessModels> {
  const codexHome = env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const source = join(codexHome, "models_cache.json");
  const payload = asRecord(await readJsonFile(source, "Codex model cache"));
  if (!payload || !Array.isArray(payload.models)) {
    throw new Error(`Codex model cache at ${source} has no models list`);
  }
  const models = payload.models.flatMap((entry) => {
    const record = asRecord(entry);
    const slug = typeof record?.slug === "string" ? record.slug.trim() : "";
    // Codex marks internal/retired models "hide"; only listed models are selectable.
    const visible = record?.visibility === undefined || record.visibility === "list";
    return slug && visible ? [slug] : [];
  });
  return {
    harness: "codex",
    models: requireModels(models, source),
    source,
    fetchedAt: typeof payload.fetched_at === "string" ? payload.fetched_at : null,
  };
}

export async function discoverClaudeModels(env: DiscoveryEnv = process.env): Promise<DiscoveredHarnessModels> {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  const catalogDir = join(configDir, "cache", "model-catalog");
  let files: string[];
  try {
    files = await readdir(catalogDir);
  } catch {
    throw new Error(`Claude Code model catalogue not found at ${catalogDir}; start Claude Code once to populate it`);
  }

  let newest: { source: string; fetchedAt: number; models: unknown[] } | null = null;
  for (const file of files) {
    // published-* files are the global document cache, not the account's model list.
    if (!file.endsWith(".json") || file.startsWith("published-")) continue;
    const source = join(catalogDir, file);
    const payload = asRecord(await readJsonFile(source, "Claude Code model catalogue").catch(() => null));
    const models = asRecord(asRecord(payload?.catalog)?.config)?.models;
    const fetchedAt = typeof payload?.fetchedAt === "number" ? payload.fetchedAt : 0;
    if (!Array.isArray(models)) continue;
    if (!newest || fetchedAt > newest.fetchedAt) newest = { source, fetchedAt, models };
  }
  if (!newest) {
    throw new Error(`No readable Claude Code model catalogue in ${catalogDir}`);
  }

  const entries = newest.models.flatMap((entry) => {
    const record = asRecord(entry);
    const id = typeof record?.id === "string" ? record.id.trim() : "";
    return id && record?.hidden !== true ? [{ id, main: record?.section === "main" }] : [];
  });
  // Main models first, then the overflow/legacy section, preserving CLI order within each.
  const models = [...entries.filter((entry) => entry.main), ...entries.filter((entry) => !entry.main)]
    .map((entry) => entry.id);
  return {
    harness: "claude",
    models: requireModels(models, newest.source),
    source: newest.source,
    fetchedAt: newest.fetchedAt ? new Date(newest.fetchedAt).toISOString() : null,
  };
}

async function readJsonFile(path: string, label: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`${label} not found at ${path}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} at ${path} is not valid JSON`);
  }
}

function requireModels(models: string[], source: string): string[] {
  const unique = [...new Set(models)];
  if (unique.length === 0) throw new Error(`No selectable models found in ${source}`);
  return unique;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Authenticated account catalogue, obtained without reading provider credentials. */
export async function discoverAntigravityModels(env: DiscoveryEnv = process.env): Promise<DiscoveredHarnessModels> {
  const command = instanceSettingsService.get("agents.antigravity_cli") || env.ANTIGRAVITY_CLI?.trim() || "agy";
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)(command, ["models"], {
      env: buildInheritedAgentEnvironment(env), timeout: 30_000, maxBuffer: 1024 * 1024,
    }));
  } catch {
    throw new Error("Antigravity model discovery failed. Verify the configured agy executable and sign in on the Autopilot host. The saved list was not changed.");
  }
  return {
    harness: "antigravity", models: parseAntigravityModels(stdout),
    source: `${command} models`, fetchedAt: new Date().toISOString(),
  };
}

export function parseAntigravityModels(output: string): string[] {
  const models = output.split(/\r?\n/).filter((line) => line.includes("\t")).map((line) => line.split("\t")[0]!.trim());
  if (models.some((model) => !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model))) {
    throw new Error("Antigravity returned an invalid model catalogue; the saved list was not changed.");
  }
  return requireModels(models, "agy models");
}

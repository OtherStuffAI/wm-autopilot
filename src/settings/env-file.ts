import { constants } from "node:fs";
import { access, copyFile, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface EnvFileEntry {
  key: string;
  value: string;
  lineIndex: number;
}

export interface EnvFileSnapshot {
  path: string;
  writable: boolean;
  entries: EnvFileEntry[];
  error: string | null;
}

export interface EnvCleanupResult {
  backupPath: string;
  removedKeys: string[];
  skippedKeys: string[];
}

const ENV_LINE_PATTERN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/;

export function resolveEnvFilePath(env: Record<string, string | undefined> = process.env): string | null {
  const explicit = env.WINGMAN_ENV_FILE?.trim();
  if (explicit) {
    return resolve(explicit.replace(/^~(?=\/)/, env.HOME ?? "~"));
  }
  return resolve(process.cwd(), ".env");
}

export async function inspectEnvFile(path: string | null): Promise<EnvFileSnapshot | null> {
  if (!path) return null;
  try {
    const stats = await stat(path);
    if (!stats.isFile()) {
      return { path, writable: false, entries: [], error: "configured path is not a file" };
    }
    const raw = await readFile(path, "utf8");
    const entries = parseEnvFile(raw);
    return {
      path,
      writable: await canWriteEnvFile(path),
      entries,
      error: null,
    };
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") {
      return { path, writable: false, entries: [], error: "env file not found" };
    }
    return {
      path,
      writable: false,
      entries: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function parseEnvFile(raw: string): EnvFileEntry[] {
  const entries: EnvFileEntry[] = [];
  const lines = raw.split(/\r?\n/);
  lines.forEach((line, lineIndex) => {
    const match = line.match(ENV_LINE_PATTERN);
    if (!match) return;
    const key = match[1];
    if (!key) return;
    const value = parseEnvValue(match[2] ?? "");
    entries.push({ key, value, lineIndex });
  });
  return entries;
}

export async function backupEnvFile(path: string, timestamp = new Date()): Promise<string> {
  await stat(path);
  const suffix = timestamp.toISOString().replace(/[:.]/g, "-");
  const backupPath = `${path}.backup.${suffix}`;
  await copyFile(path, backupPath);
  return backupPath;
}

export async function cleanupEnvFile(path: string, keys: string[]): Promise<EnvCleanupResult> {
  const uniqueKeys = Array.from(new Set(keys.map((key) => key.trim()).filter(Boolean)));
  if (uniqueKeys.length === 0) {
    throw new Error("No env keys selected for cleanup");
  }
  const raw = await readFile(path, "utf8");
  const backupPath = await backupEnvFile(path);
  const keySet = new Set(uniqueKeys);
  const removed = new Set<string>();
  const lines = raw.split(/\r?\n/);
  const nextLines = lines.filter((line) => {
    const match = line.match(ENV_LINE_PATTERN);
    if (!match) return true;
    const key = match[1];
    if (!key) return true;
    if (!keySet.has(key)) return true;
    removed.add(key);
    return false;
  });
  await writeFile(path, nextLines.join("\n"), "utf8");
  return {
    backupPath,
    removedKeys: Array.from(removed),
    skippedKeys: uniqueKeys.filter((key) => !removed.has(key)),
  };
}

async function canWriteEnvFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK | constants.W_OK);
    await access(dirname(path), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function parseEnvValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote) && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  const commentIndex = trimmed.search(/\s#/);
  return commentIndex >= 0 ? trimmed.slice(0, commentIndex).trim() : trimmed;
}

/**
 * Simple .env file parser
 * Reads key=value pairs from .env files without external dependencies
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Parse a .env file content into a key-value object
 * Handles:
 * - KEY=value
 * - KEY="quoted value"
 * - KEY='single quoted value'
 * - # comments
 * - Empty lines
 */
export function parseEnvContent(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    // Find the first = sign
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Remove surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Only set if key is valid (no spaces, alphanumeric with underscores)
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      env[key] = value;
    }
  }

  return env;
}

/**
 * Read and parse a .env file from a directory
 * Returns empty object if file doesn't exist or can't be read
 */
export async function readEnvFile(directory: string, filename = ".env"): Promise<Record<string, string>> {
  try {
    const envPath = join(directory, filename);
    const content = await readFile(envPath, "utf-8");
    return parseEnvContent(content);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return {};
    }
    // Log but don't throw for other errors - env loading shouldn't break app startup
    console.warn(`[env-file] Error reading ${filename} from ${directory}: ${nodeError.message}`);
    return {};
  }
}

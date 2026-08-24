import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { normaliseAppEnvKey, type AppEnvironmentVariables } from "./app-env";

export interface DotenvParseResult {
  env: AppEnvironmentVariables;
  warnings: string[];
}

function stripInlineComment(value: string): string {
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (char === "#" && !quote && (index === 0 || /\s/.test(value[index - 1] ?? ""))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trimEnd();
}

function unquoteValue(value: string): string {
  const trimmed = stripInlineComment(value).trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseDotenvText(text: string): DotenvParseResult {
  const env: AppEnvironmentVariables = {};
  const warnings: string[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const withoutExport = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
    const equalsIndex = withoutExport.indexOf("=");
    if (equalsIndex < 1) {
      warnings.push(`Line ${lineNumber} ignored: expected KEY=value`);
      return;
    }
    const rawKey = withoutExport.slice(0, equalsIndex).trim();
    try {
      const key = normaliseAppEnvKey(rawKey);
      env[key] = unquoteValue(withoutExport.slice(equalsIndex + 1));
    } catch (error) {
      warnings.push(`Line ${lineNumber} ignored: ${(error as Error).message}`);
    }
  });
  return { env, warnings };
}

export async function readDotenvFile(appRoot: string, filename = ".env"): Promise<DotenvParseResult & { path: string }> {
  const path = join(appRoot, filename);
  const text = await readFile(path, "utf8");
  return { path, ...parseDotenvText(text) };
}

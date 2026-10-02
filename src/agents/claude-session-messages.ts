import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { ClaudeMessageImporter, parseJsonLine } from "./claude-message-importer";

import type { ReplaceMessageInput } from "../storage/message-store";

export interface ClaudeSessionMessagesInput {
  claudeHome?: string;
  sessionId: string;
  workingDirectory: string;
}

const MAX_SESSION_FILE_BYTES = 50 * 1024 * 1024;

export async function readClaudeSessionMessages(
  input: ClaudeSessionMessagesInput,
): Promise<ReplaceMessageInput[]> {
  const sessionId = input.sessionId.trim();
  const workingDirectory = input.workingDirectory.trim();
  if (!sessionId || !workingDirectory) {
    return [];
  }

  const filePath = await findClaudeSessionFile({
    claudeHome: resolveClaudeHome(input.claudeHome),
    sessionId,
    workingDirectory,
  });
  if (!filePath) {
    return [];
  }

  return readClaudeSessionMessagesFromFile(filePath);
}

export async function readClaudeSessionMessagesFromFile(
  filePath: string,
): Promise<ReplaceMessageInput[]> {
  const content = await readFile(filePath, "utf8").catch(() => "");
  if (!content) {
    return [];
  }

  const importer = new ClaudeMessageImporter();
  for (const line of content.split("\n")) {
    const record = parseJsonLine(line);
    if (record) {
      importer.addRecord(record);
    }
  }
  return importer.finish();
}

export function resolveClaudeHome(value?: string | null): string {
  const raw = typeof value === "string" && value.trim()
    ? value.trim()
    : typeof Bun.env.CLAUDE_CONFIG_DIR === "string" && Bun.env.CLAUDE_CONFIG_DIR.trim()
      ? Bun.env.CLAUDE_CONFIG_DIR.trim()
      : typeof process.env.CLAUDE_CONFIG_DIR === "string" && process.env.CLAUDE_CONFIG_DIR.trim()
        ? process.env.CLAUDE_CONFIG_DIR.trim()
        : "~/.claude";
  if (raw === "~") {
    return homedir();
  }
  if (raw.startsWith("~/")) {
    return join(homedir(), raw.slice(2));
  }
  return raw;
}

export async function findClaudeSessionFile(options: {
  claudeHome: string;
  sessionId: string;
  workingDirectory: string;
}): Promise<string | null> {
  const projectsRoot = join(options.claudeHome, "projects");
  const exactPath = join(projectsRoot, options.workingDirectory.replace(/[^a-zA-Z0-9]/g, "-"), `${options.sessionId}.jsonl`);
  const exactMeta = await readClaudeSessionMeta(exactPath);
  if (exactMeta?.sessionId === options.sessionId && exactMeta.cwd === options.workingDirectory) {
    return exactPath;
  }
  const files = await listClaudeSessionFiles(projectsRoot).catch(() => []);
  const filenameMatches = files.filter((file) => basename(file) === `${options.sessionId}.jsonl`);
  for (const filePath of [...filenameMatches, ...files.filter((file) => !filenameMatches.includes(file))]) {
    const meta = await readClaudeSessionMeta(filePath);
    if (meta?.sessionId === options.sessionId && meta.cwd === options.workingDirectory) {
      return filePath;
    }
  }
  return null;
}

async function listClaudeSessionFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        return;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        return;
      }
      const stats = await stat(entryPath).catch(() => null);
      if (!stats || stats.size > MAX_SESSION_FILE_BYTES) {
        return;
      }
      files.push(entryPath);
    }));
  }

  await walk(root);
  return files;
}

async function readClaudeSessionMeta(filePath: string): Promise<{ sessionId: string; cwd: string } | null> {
  const content = await readFile(filePath, "utf8").catch(() => "");
  for (const line of content.split("\n")) {
    const record = parseJsonLine(line);
    if (!record || record.type !== "user") {
      continue;
    }
    const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
    const cwd = typeof record.cwd === "string" ? record.cwd.trim() : "";
    if (sessionId && cwd) {
      return { sessionId, cwd };
    }
  }
  return null;
}

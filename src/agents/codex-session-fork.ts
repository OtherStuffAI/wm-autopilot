import { randomUUID } from "node:crypto";
import { open, mkdir, readdir, stat, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

interface CodexSessionMeta {
  id: string;
  cwd: string;
}

export interface CodexSessionForkInput {
  codexHome?: string;
  sourceSessionId: string;
  workingDirectory: string;
  now?: Date;
}

export interface CodexSessionForkResult {
  sourceSessionId: string;
  forkedSessionId: string;
  sourceFilePath: string;
  forkedFilePath: string;
}

const MAX_SESSION_FILE_BYTES = 50 * 1024 * 1024;
const FIRST_LINE_CHUNK_BYTES = 64 * 1024;
const FIRST_LINE_MAX_BYTES = 4 * 1024 * 1024;

export function resolveCodexHome(value?: string | null): string {
  const raw = typeof value === "string" && value.trim()
    ? value.trim()
    : typeof Bun.env.CODEX_HOME === "string" && Bun.env.CODEX_HOME.trim()
      ? Bun.env.CODEX_HOME.trim()
      : typeof process.env.CODEX_HOME === "string" && process.env.CODEX_HOME.trim()
        ? process.env.CODEX_HOME.trim()
        : "~/.codex";
  if (raw === "~") {
    return homedir();
  }
  if (raw.startsWith("~/")) {
    return join(homedir(), raw.slice(2));
  }
  return raw;
}

export async function forkCodexSessionFile(input: CodexSessionForkInput): Promise<CodexSessionForkResult> {
  const sourceSessionId = input.sourceSessionId.trim();
  const workingDirectory = input.workingDirectory.trim();
  if (!sourceSessionId) {
    throw new Error("Source native Codex session id is required");
  }
  if (!workingDirectory) {
    throw new Error("Working directory is required to fork a Codex session");
  }

  const codexHome = resolveCodexHome(input.codexHome);
  const sourceFilePath = await findCodexSessionFile({
    codexHome,
    sessionId: sourceSessionId,
    workingDirectory,
  });
  if (!sourceFilePath) {
    throw new Error(`Native Codex session file not found for ${sourceSessionId}`);
  }

  const now = input.now ?? new Date();
  const forkedSessionId = randomUUID();
  const forkedFilePath = await buildForkedSessionFilePath(codexHome, forkedSessionId, now);
  const sourceContent = await readFile(sourceFilePath, "utf8");
  const forkedContent = rewriteCodexSessionMeta(sourceContent, {
    sourceSessionId,
    forkedSessionId,
    timestamp: now.toISOString(),
    workingDirectory,
  });

  await mkdir(dirname(forkedFilePath), { recursive: true });
  await writeFile(forkedFilePath, forkedContent, { mode: 0o600 });

  return {
    sourceSessionId,
    forkedSessionId,
    sourceFilePath,
    forkedFilePath,
  };
}

export async function findCodexSessionFile(options: {
  codexHome: string;
  sessionId: string;
  workingDirectory: string;
}): Promise<string | null> {
  return findCodexSessionFileWithPolicy(options, null);
}

export async function findCodexSessionFileForReading(options: {
  codexHome: string;
  sessionId: string;
  workingDirectory: string;
}): Promise<string | null> {
  return findCodexSessionFileWithPolicy(options, options.sessionId);
}

async function findCodexSessionFileWithPolicy(
  options: { codexHome: string; sessionId: string; workingDirectory: string },
  oversizedExactSessionId: string | null,
): Promise<string | null> {
  const sessionsRoot = join(options.codexHome, "sessions");
  const files = await listCodexSessionFiles(sessionsRoot, oversizedExactSessionId).catch(() => []);
  const filenameMatches = files.filter((file) => basename(file).includes(options.sessionId));
  for (const filePath of [...filenameMatches, ...files.filter((file) => !filenameMatches.includes(file))]) {
    const meta = await readCodexSessionMeta(filePath);
    if (
      meta?.id === options.sessionId &&
      meta.cwd === options.workingDirectory
    ) {
      return filePath;
    }
  }
  return null;
}

async function listCodexSessionFiles(root: string, oversizedExactSessionId: string | null): Promise<string[]> {
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
      const isExactFilenameMatch = Boolean(oversizedExactSessionId) &&
        entry.name.endsWith(`-${oversizedExactSessionId}.jsonl`);
      if (!stats || (stats.size > MAX_SESSION_FILE_BYTES && !isExactFilenameMatch)) {
        return;
      }
      files.push(entryPath);
    }));
  }

  await walk(root);
  return files;
}

async function readCodexSessionMeta(filePath: string): Promise<CodexSessionMeta | null> {
  const line = await readFirstLine(filePath).catch(() => "");
  if (!line.trim()) {
    return null;
  }
  const record = parseJsonLine(line);
  return record?.type === "session_meta" ? parseSessionMeta(record) : null;
}

async function readFirstLine(filePath: string): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < FIRST_LINE_MAX_BYTES) {
      const buffer = Buffer.alloc(Math.min(FIRST_LINE_CHUNK_BYTES, FIRST_LINE_MAX_BYTES - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) {
        break;
      }
      const chunk = buffer.subarray(0, bytesRead);
      const newlineIndex = chunk.indexOf(10);
      if (newlineIndex >= 0) {
        chunks.push(chunk.subarray(0, newlineIndex));
        break;
      }
      chunks.push(chunk);
      offset += bytesRead;
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await handle.close();
  }
}

function rewriteCodexSessionMeta(
  content: string,
  options: {
    sourceSessionId: string;
    forkedSessionId: string;
    timestamp: string;
    workingDirectory: string;
  },
): string {
  const lines = content.split("\n");
  const metaIndex = lines.findIndex((line) => {
    const record = parseJsonLine(line);
    return record?.type === "session_meta";
  });
  if (metaIndex < 0) {
    throw new Error("Native Codex session file is missing session_meta");
  }

  const record = parseJsonLine(lines[metaIndex]!)!;
  const meta = parseSessionMeta(record);
  if (!meta || meta.id !== options.sourceSessionId || meta.cwd !== options.workingDirectory) {
    throw new Error("Native Codex session metadata does not match the source session");
  }
  const payload = record.payload as Record<string, unknown>;
  lines[metaIndex] = JSON.stringify({
    ...record,
    timestamp: options.timestamp,
    payload: {
      ...payload,
      id: options.forkedSessionId,
      timestamp: options.timestamp,
      thread_source: "fork",
    },
  });
  return lines.join("\n");
}

async function buildForkedSessionFilePath(
  codexHome: string,
  forkedSessionId: string,
  now: Date,
): Promise<string> {
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const dir = join(codexHome, "sessions", year, month, day);
  const timestamp = formatCodexLocalTimestamp(now);
  const filePath = join(dir, `rollout-${timestamp}-${forkedSessionId}.jsonl`);
  const existing = await stat(filePath).catch(() => null);
  if (existing) {
    throw new Error(`Forked Codex session file already exists: ${filePath}`);
  }
  return filePath;
}

function formatCodexLocalTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}-${minutes}-${seconds}`;
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function parseSessionMeta(record: Record<string, unknown>): CodexSessionMeta | null {
  const payload = record.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const data = payload as Record<string, unknown>;
  const id = typeof data.id === "string" ? data.id.trim() : "";
  const cwd = typeof data.cwd === "string" ? data.cwd.trim() : "";
  if (!id || !cwd) {
    return null;
  }
  return { id, cwd };
}

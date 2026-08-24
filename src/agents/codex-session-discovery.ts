import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

interface CodexSessionMeta {
  id: string;
  cwd: string;
  timestampMs: number | null;
}

interface CodexSessionCandidate {
  sessionId: string;
  filePath: string;
  matchTimestampMs: number | null;
  fileModifiedMs: number;
}

export interface CodexSessionDiscoveryInput {
  codexHome: string;
  workingDirectory: string;
  prompt: string;
  sessionStartedAtMs: number;
  sentAtMs: number;
  nowMs?: number;
  maxFiles?: number;
}

export interface CodexSessionDiscoveryResult {
  sessionId: string | null;
  filePath: string | null;
  reason: "matched" | "not_found" | "ambiguous" | "invalid_input";
  candidateCount: number;
}

const MAX_DEFAULT_FILES = 200;
const MAX_SESSION_FILE_BYTES = 50 * 1024 * 1024;
const STARTED_AT_SKEW_MS = 5 * 60 * 1000;
const SENT_AT_SKEW_MS = 60 * 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;

export function normaliseCodexPromptForMatch(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function fingerprintCodexPrompt(value: string): string {
  return createHash("sha256").update(normaliseCodexPromptForMatch(value)).digest("hex");
}

export function matchesCodexPrompt(recordedPrompt: string, expectedPrompt: string): boolean {
  const recorded = normaliseCodexPromptForMatch(recordedPrompt);
  const expected = normaliseCodexPromptForMatch(expectedPrompt);
  if (!recorded || !expected) {
    return false;
  }
  return recorded === expected
    || recorded === `${expected} ${expected}`
    || recorded === `${expected}${expected}`;
}

export async function discoverCodexSessionIdForPrompt(
  input: CodexSessionDiscoveryInput,
): Promise<CodexSessionDiscoveryResult> {
  const promptFingerprint = fingerprintCodexPrompt(input.prompt);
  if (!input.codexHome || !input.workingDirectory || !promptFingerprint) {
    return emptyResult("invalid_input");
  }

  const sessionsRoot = join(input.codexHome, "sessions");
  const nowMs = input.nowMs ?? Date.now();
  const earliestFileMs = Math.max(0, input.sessionStartedAtMs - STARTED_AT_SKEW_MS);
  const latestMatchMs = nowMs + FUTURE_SKEW_MS;
  const files = await listRecentCodexSessionFiles(sessionsRoot, {
    earliestModifiedMs: earliestFileMs,
    maxFiles: input.maxFiles ?? MAX_DEFAULT_FILES,
  }).catch(() => []);

  const candidates: CodexSessionCandidate[] = [];
  for (const file of files) {
    const candidate = await readCandidateFromFile(file.path, {
      expectedCwd: input.workingDirectory,
      expectedPrompt: input.prompt,
      earliestMatchMs: input.sentAtMs - SENT_AT_SKEW_MS,
      latestMatchMs,
      fileModifiedMs: file.modifiedMs,
    });
    if (candidate) {
      candidates.push(candidate);
    }
  }

  const uniqueBySession = new Map<string, CodexSessionCandidate>();
  for (const candidate of candidates) {
    uniqueBySession.set(candidate.sessionId, candidate);
  }
  const uniqueCandidates = Array.from(uniqueBySession.values());
  if (uniqueCandidates.length === 1) {
    const match = uniqueCandidates[0]!;
    return {
      sessionId: match.sessionId,
      filePath: match.filePath,
      reason: "matched",
      candidateCount: 1,
    };
  }
  if (uniqueCandidates.length > 1) {
    return {
      sessionId: null,
      filePath: null,
      reason: "ambiguous",
      candidateCount: uniqueCandidates.length,
    };
  }
  return emptyResult("not_found");
}

async function listRecentCodexSessionFiles(
  root: string,
  options: { earliestModifiedMs: number; maxFiles: number },
): Promise<Array<{ path: string; modifiedMs: number }>> {
  const files: Array<{ path: string; modifiedMs: number }> = [];

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
      if (!stats || stats.size > MAX_SESSION_FILE_BYTES || stats.mtimeMs < options.earliestModifiedMs) {
        return;
      }
      files.push({ path: entryPath, modifiedMs: stats.mtimeMs });
    }));
  }

  await walk(root);
  return files
    .sort((a, b) => b.modifiedMs - a.modifiedMs)
    .slice(0, Math.max(1, options.maxFiles));
}

async function readCandidateFromFile(
  filePath: string,
  options: {
    expectedCwd: string;
    expectedPrompt: string;
    earliestMatchMs: number;
    latestMatchMs: number;
    fileModifiedMs: number;
  },
): Promise<CodexSessionCandidate | null> {
  const content = await readFile(filePath, "utf8").catch(() => "");
  if (!content) {
    return null;
  }

  let meta: CodexSessionMeta | null = null;
  for (const line of content.split("\n")) {
    const record = parseJsonLine(line);
    if (!record) {
      continue;
    }
    if (!meta && record.type === "session_meta") {
      meta = parseSessionMeta(record);
      if (!meta || meta.cwd !== options.expectedCwd) {
        return null;
      }
      continue;
    }
    if (!meta) {
      continue;
    }

    const promptText = extractUserPromptText(record);
    if (!promptText || !matchesCodexPrompt(promptText, options.expectedPrompt)) {
      continue;
    }
    const timestampMs = parseTimestampMs(record.timestamp);
    if (
      timestampMs !== null &&
      (timestampMs < options.earliestMatchMs || timestampMs > options.latestMatchMs)
    ) {
      continue;
    }
    return {
      sessionId: meta.id,
      filePath,
      matchTimestampMs: timestampMs,
      fileModifiedMs: options.fileModifiedMs,
    };
  }

  return null;
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
  return {
    id,
    cwd,
    timestampMs: parseTimestampMs(data.timestamp),
  };
}

function extractUserPromptText(record: Record<string, unknown>): string | null {
  const payload = record.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const data = payload as Record<string, unknown>;

  if (record.type === "event_msg" && data.type === "user_message") {
    return typeof data.message === "string" ? data.message : null;
  }

  if (record.type === "response_item" && data.type === "message" && data.role === "user") {
    const content = data.content;
    if (!Array.isArray(content)) {
      return null;
    }
    const parts = content
      .map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return "";
        }
        const value = item as Record<string, unknown>;
        return typeof value.text === "string" ? value.text : "";
      })
      .filter((value) => value.length > 0);
    return parts.length > 0 ? parts.join("\n") : null;
  }

  return null;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function emptyResult(reason: CodexSessionDiscoveryResult["reason"]): CodexSessionDiscoveryResult {
  return {
    sessionId: null,
    filePath: null,
    reason,
    candidateCount: 0,
  };
}

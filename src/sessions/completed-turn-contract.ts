import { isAbsolute } from "node:path";
import { validateSnapshot, PROJECT_PROFILE, type ProjectFile } from "../isolation/project-profile.ts";

export interface CompletedTurnRequest {
  conversationKey: string;
  requestId: string;
  projectId: string;
  prompt: string;
  directory: string;
  sessionId: string | null;
  model: string | null;
  executionProfile: "isolated-codex" | null;
  projectFiles: ProjectFile[] | null;
  durationMs: number | null;
}

export interface CompletedTurnReceipt {
  receiptId: string;
  conversationKey: string;
  requestId: string;
  projectId: string;
  runId: string;
  stepId: string;
  sessionId: string | null;
  executionId: string | null;
  nativeSessionId: string | null;
  status: "queued" | "preparing" | "sending" | "completed" | "uncertain";
  sequence: number;
  reply: string | null;
  error: string | null;
  output: Record<string, unknown> | null;
}

export function parseCompletedTurnRequest(input: Record<string, unknown>): CompletedTurnRequest {
  function text(key: string, max: number): string {
    const value = input[key];
    if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max || value.includes("\0")) {
      throw new Error(`session.completedTurn requires ${key} (maximum ${max} bytes)`);
    }
    return value;
  }
  const isolated = input.executionProfile === "isolated-codex";
  if (input.executionProfile !== undefined && input.executionProfile !== null && !isolated) throw new Error("Unsupported completed-turn execution profile; builder execution is gated");
  const directory = isolated && input.directory === undefined ? "/workspace" : text("directory", 4096);
  if (!isAbsolute(directory)) throw new Error("session.completedTurn directory must be absolute");
  if (input.agent !== undefined && input.agent !== "codex") throw new Error("Native completed turns currently require Codex SDK");
  if (isolated) {
    if (directory !== "/workspace" || input.sessionId) throw new Error("Isolated completed turns require /workspace and no Wingman session ID");
    validateSnapshot(input.projectFiles as ProjectFile[]);
    if (typeof input.prompt !== "string" || input.prompt.length > 16000) throw new Error("Isolated native prompt exceeds runtime limit");
  }
  const durationMs = isolated ? input.durationMs ?? PROJECT_PROFILE.maxDurationMs : null;
  if (isolated && (typeof durationMs !== "number" || !Number.isInteger(durationMs) || durationMs < 1 || durationMs > PROJECT_PROFILE.maxDurationMs)) {
    throw new Error("Invalid isolated completed-turn deadline");
  }
  return {
    conversationKey: text("conversationKey", 200), requestId: text("requestId", 200),
    projectId: text("projectId", 200), prompt: text("prompt", 250_000), directory,
    sessionId: input.sessionId === undefined || input.sessionId === null ? null : text("sessionId", 200),
    model: input.model === undefined || input.model === null ? null : text("model", 200),
    executionProfile: isolated ? "isolated-codex" : null,
    projectFiles: isolated ? input.projectFiles as ProjectFile[] : null,
    durationMs: durationMs as number | null,
  };
}

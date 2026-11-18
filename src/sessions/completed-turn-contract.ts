import { interviewDirectory, parseInterviewInput, type ScopedInterviewInput } from "../agents/scoped-interview/contract.ts";
import { isAbsolute } from "node:path";
import { validateSnapshot, PROJECT_PROFILE, type ProjectFile } from "../isolation/project-profile.ts";

export interface CompletedTurnRequest {
  agent?: "codex" | "goose" | "claude";
  conversationKey: string;
  requestId: string;
  projectId: string;
  prompt: string;
  directory: string;
  sessionId: string | null;
  model: string | null;
  executionProfile: "isolated-codex" | "scoped-interview" | null;
  scopedInterview?: ScopedInterviewInput;
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
  status: "queued" | "preparing" | "sending" | "completed" | "uncertain" | "abandoned" | "abandoning";
  sequence: number;
  reply: string | null;
  error: string | null;
  output: Record<string, unknown> | null;
}

export function parseCompletedTurnRequest(input: Record<string, unknown>, owner?: string): CompletedTurnRequest {
  function text(key: string, max: number): string {
    const value = input[key];
    if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max || value.includes("\0")) {
      throw new Error(`session.completedTurn requires ${key} (maximum ${max} bytes)`);
    }
    return value;
  }
  const interview = input.executionProfile === "scoped-interview";
  if (interview && (!owner || input.agent !== "claude" || input.directory !== undefined || input.sessionId || input.projectFiles)) throw Error("Scoped interview requires Claude, authenticated owner and server-selected directory/session");
  if (!interview && input.scopedInterview !== undefined) throw Error("scopedInterview requires its execution profile");
  const isolated = input.executionProfile === "isolated-codex";
  if (input.executionProfile !== undefined && input.executionProfile !== null && !isolated && !interview) throw new Error("Unsupported completed-turn execution profile; builder execution is gated");
  const directory = interview ? interviewDirectory(owner!, text("conversationKey",200)) : isolated && input.directory === undefined ? "/workspace" : text("directory", 4096);
  if (!isAbsolute(directory)) throw new Error("session.completedTurn directory must be absolute");
  if (input.agent !== undefined && input.agent !== "codex" && input.agent !== "goose" && input.agent !== "claude") throw new Error("Unsupported completed-turn agent");
  if (isolated && input.agent && input.agent !== "codex") throw new Error("Isolated completed turns require Codex SDK");
  if (isolated) {
    if (directory !== "/workspace" || input.sessionId) throw new Error("Isolated completed turns require /workspace and no Wingman session ID");
    validateSnapshot(input.projectFiles as ProjectFile[]);
    if (typeof input.prompt !== "string" || input.prompt.length > 16000) throw new Error("Isolated native prompt exceeds runtime limit");
  }
  const durationMs = interview ? input.durationMs ?? 90_000 : isolated ? input.durationMs ?? PROJECT_PROFILE.maxDurationMs : null;
  if ((isolated || interview) && (typeof durationMs !== "number" || !Number.isInteger(durationMs) || durationMs < 1 || durationMs > (interview ? 90_000 : PROJECT_PROFILE.maxDurationMs))) {
    throw new Error("Invalid isolated completed-turn deadline");
  }
  return {
    ...((input.agent === "goose" || input.agent === "claude") ? {agent: input.agent} : {}),
    conversationKey: text("conversationKey", 200), requestId: text("requestId", 200),
    projectId: text("projectId", 200), prompt: text("prompt", 250_000), directory,
    sessionId: input.sessionId === undefined || input.sessionId === null ? null : text("sessionId", 200),
    model: input.model === undefined || input.model === null ? null : text("model", 200),
    executionProfile: interview ? "scoped-interview" : isolated ? "isolated-codex" : null,
    ...(interview ? {scopedInterview: parseInterviewInput(input.scopedInterview)} : {}),
    projectFiles: isolated ? input.projectFiles as ProjectFile[] : null,
    durationMs: durationMs as number | null,
  };
}

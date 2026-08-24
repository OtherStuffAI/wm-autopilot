import { randomUUID } from "node:crypto";

import type { AgentType } from "../config";
import {
  normaliseSessionMetadata,
  type NativeAgentSessionMetadata,
  type SessionMetadata,
} from "../sessions/session-metadata";
import type { AgentAdapter } from "./agent-adapter";

const NATIVE_RESUME_AGENTS = new Set<AgentType>(["claude", "codex", "goose", "maple", "opencode", "pi"]);

export function supportsNativeSessionResume(agent: AgentType): boolean {
  return NATIVE_RESUME_AGENTS.has(agent);
}

export function createNativeAgentSessionMetadata(
  agent: AgentType,
  sessionId: string,
  workingDirectory: string,
  source: NativeAgentSessionMetadata["source"],
): NativeAgentSessionMetadata {
  return {
    agent,
    sessionId,
    workingDirectory,
    capturedAt: new Date().toISOString(),
    source,
  };
}

export function prepareNativeAgentSessionMetadata(
  agent: AgentType,
  workingDirectory: string,
  metadata: SessionMetadata,
): SessionMetadata {
  if (metadata.nativeAgentSession?.sessionId) {
    return normaliseSessionMetadata({
      ...metadata,
      nativeAgentSession: {
        ...metadata.nativeAgentSession,
        agent,
        workingDirectory,
      },
    });
  }

  if (agent !== "claude") {
    return metadata;
  }

  return normaliseSessionMetadata({
    ...metadata,
    nativeAgentSession: createNativeAgentSessionMetadata(
      agent,
      randomUUID(),
      workingDirectory,
      "preallocated",
    ),
  });
}

export function buildNativeAgentCommand(
  command: string[],
  agent: AgentType,
  metadata: SessionMetadata,
): string[] {
  const nativeSession = metadata.nativeAgentSession;
  if (!nativeSession?.sessionId || nativeSession.agent !== agent) {
    return command;
  }

  if (hasNativeResumeOrigin(metadata)) {
    return buildNativeResumeCommand(command, agent, nativeSession.sessionId);
  }

  if (agent === "claude" && nativeSession.source === "preallocated") {
    return insertCliArgs(command, ["--session-id", nativeSession.sessionId]);
  }

  return command;
}

export function getAdapterNativeSessionId(
  agent: AgentType,
  adapter: AgentAdapter | undefined,
): string | null {
  if (!adapter) return null;
  if (agent === "codex") {
    const candidate = adapter as AgentAdapter & { getThreadId?: () => string | null };
    return candidate.getThreadId?.() ?? null;
  }
  if (agent === "opencode") {
    const candidate = adapter as AgentAdapter & { getSessionId?: () => string | null };
    return candidate.getSessionId?.() ?? null;
  }
  if (agent === "goose" || agent === "maple" || agent === "pi") {
    const candidate = adapter as AgentAdapter & { getSessionId?: () => string | null };
    return candidate.getSessionId?.() ?? null;
  }
  return null;
}

function buildNativeResumeCommand(command: string[], agent: AgentType, sessionId: string): string[] {
  if (agent === "claude") {
    return insertCliArgs(command, ["--resume", sessionId]);
  }
  if (agent === "codex") {
    return insertCliArgs(command, ["resume", sessionId]);
  }
  return command;
}

function hasNativeResumeOrigin(metadata: SessionMetadata): boolean {
  return Boolean(
    metadata.resumedFromWingmanSessionId ||
    metadata.branchedFromWingmanSessionId,
  );
}

function insertCliArgs(command: string[], args: string[]): string[] {
  if (command.length === 0) return command;
  const separatorIndex = command.indexOf("--");
  const cliIndex = separatorIndex >= 0 ? separatorIndex + 1 : 0;
  if (cliIndex >= command.length) return [...command, ...args];
  return [
    ...command.slice(0, cliIndex + 1),
    ...args,
    ...command.slice(cliIndex + 1),
  ];
}

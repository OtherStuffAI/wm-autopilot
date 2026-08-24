import type { AgentType } from "../config";
import type { SessionOrigin, SessionSnapshot } from "../agents/process-manager";
import type { StoredSessionRecord } from "../storage/message-store";
import { supportsNativeSessionResume } from "../agents/native-session";
import {
  normaliseSessionMetadata,
  resolveSessionChargeNpub,
  type SessionMetadata,
} from "./session-metadata";
import { resolveSessionOwnerNpub } from "./session-ownership";

export type NativeResumeSourceSession = Pick<
  SessionSnapshot | StoredSessionRecord,
  "id" | "agent" | "name" | "npub" | "workingDirectory" | "metadata"
>;

export interface NativeResumeLaunch {
  agent: AgentType;
  workingDirectory: string;
  name: string;
  origin: SessionOrigin;
  ownerNpub: string | undefined;
  metadata: SessionMetadata;
}

export class NativeResumeLaunchError extends Error {
  constructor(message: string, readonly status: number = 409) {
    super(message);
    this.name = "NativeResumeLaunchError";
  }
}

export function resolveNativeResumeLaunch(
  source: NativeResumeSourceSession,
  isAgentType: (agent: string) => agent is AgentType,
  actorNpub?: string | null,
): NativeResumeLaunch {
  const sourceMetadata = normaliseSessionMetadata(source.metadata);
  const nativeSession = sourceMetadata.nativeAgentSession;
  if (!nativeSession?.sessionId) {
    throw new NativeResumeLaunchError("Session does not have a native agent session id to resume");
  }
  const agent = nativeSession.agent || source.agent;
  if (!isAgentType(agent) || !supportsNativeSessionResume(agent)) {
    throw new NativeResumeLaunchError(`Native resume is not supported for ${agent || "this agent"}`, 400);
  }
  const workingDirectory = nativeSession.workingDirectory || source.workingDirectory;
  if (!workingDirectory) {
    throw new NativeResumeLaunchError("Session does not have a working directory to resume");
  }

  const ownerNpub = resolveSessionOwnerNpub(source.npub ?? null, sourceMetadata) ?? undefined;
  const sourceName = typeof source.name === "string" && source.name.trim()
    ? source.name.trim()
    : source.id;
  return {
    agent,
    workingDirectory,
    name: `${sourceName} (resumed)`,
    origin: { type: "native-resume", id: source.id, label: `Native resume from ${sourceName}` },
    ownerNpub,
    metadata: normaliseSessionMetadata({
      ...sourceMetadata,
      nativeAgentSession: {
        ...nativeSession,
        agent,
        workingDirectory,
      },
      resumedFromWingmanSessionId: source.id,
      ownerNpub,
      createdByNpub: actorNpub ?? sourceMetadata.createdByNpub,
      lastManagedByNpub: actorNpub ?? undefined,
      chargeToNpub: resolveSessionChargeNpub(sourceMetadata, source.npub ?? null) ?? undefined,
    }),
  };
}

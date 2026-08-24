import type { AgentType } from "../config";
import type { ProcessManager } from "../agents/process-manager";
import {
  normaliseSessionMetadata,
  resolveSessionChargeNpub,
  type SessionMetadata,
} from "./session-metadata";
import { resolveSessionOwnerNpub } from "./session-ownership";
import {
  resolveNativeResumeLaunch,
  type NativeResumeSourceSession,
} from "./native-resume-launch";

export type RestartReplacementDisposition = "resumed" | "fresh";

export interface RestartReplacementResult {
  sourceSessionId: string;
  sessionId: string;
  disposition: RestartReplacementDisposition;
  reason?: string;
}

interface FreshRestartLaunch {
  agent: AgentType;
  workingDirectory: string;
  name: string;
  ownerNpub: string | undefined;
  metadata: SessionMetadata;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveFreshRestartLaunch(
  source: NativeResumeSourceSession,
  isAgentType: (agent: string) => agent is AgentType,
  actorNpub?: string | null,
): FreshRestartLaunch {
  const agentValue = typeof source.agent === "string" ? source.agent.trim().toLowerCase() : "";
  if (!isAgentType(agentValue)) {
    throw new Error(`Fresh restart is not supported for ${agentValue || "this agent"}`);
  }
  const workingDirectory = typeof source.workingDirectory === "string"
    ? source.workingDirectory.trim()
    : "";
  if (!workingDirectory) {
    throw new Error("Session does not have a working directory for a fresh restart");
  }

  const sourceMetadata = normaliseSessionMetadata(source.metadata);
  const ownerNpub = resolveSessionOwnerNpub(source.npub ?? null, sourceMetadata) ?? undefined;
  const sourceName = typeof source.name === "string" && source.name.trim()
    ? source.name.trim()
    : source.id;
  const metadata = normaliseSessionMetadata({
    ...sourceMetadata,
    nativeAgentSession: undefined,
    resumedFromWingmanSessionId: undefined,
    branchedFromWingmanSessionId: undefined,
    branchConversationMode: undefined,
    branchConversationMessageCount: undefined,
    ownerNpub,
    createdByNpub: actorNpub ?? sourceMetadata.createdByNpub,
    lastManagedByNpub: actorNpub ?? undefined,
    chargeToNpub: resolveSessionChargeNpub(sourceMetadata, source.npub ?? null) ?? undefined,
  });

  return {
    agent: agentValue,
    workingDirectory,
    name: `${sourceName} (fresh restart)`,
    ownerNpub,
    metadata,
  };
}

export async function createRestartReplacement(
  manager: ProcessManager,
  source: NativeResumeSourceSession,
  isAgentType: (agent: string) => agent is AgentType,
  actorNpub?: string | null,
): Promise<RestartReplacementResult> {
  let nativeResumeFailure = "Native resume metadata is unavailable";
  try {
    const launch = resolveNativeResumeLaunch(source, isAgentType, actorNpub);
    try {
      const session = await manager.createSession(
        launch.agent,
        launch.workingDirectory,
        launch.name,
        launch.origin,
        undefined,
        launch.ownerNpub,
        launch.metadata,
      );
      return {
        sourceSessionId: source.id,
        sessionId: session.id,
        disposition: "resumed",
      };
    } catch (error) {
      nativeResumeFailure = `Native resume failed: ${errorMessage(error)}`;
    }
  } catch (error) {
    nativeResumeFailure = errorMessage(error);
  }

  const fresh = resolveFreshRestartLaunch(source, isAgentType, actorNpub);
  try {
    const session = await manager.createSession(
      fresh.agent,
      fresh.workingDirectory,
      fresh.name,
      {
        type: "restart-fresh",
        id: source.id,
        label: `Fresh restart from ${source.name || source.id}`,
      },
      undefined,
      fresh.ownerNpub,
      fresh.metadata,
    );
    return {
      sourceSessionId: source.id,
      sessionId: session.id,
      disposition: "fresh",
      reason: nativeResumeFailure,
    };
  } catch (error) {
    throw new Error(`${nativeResumeFailure}; fresh restart failed: ${errorMessage(error)}`);
  }
}

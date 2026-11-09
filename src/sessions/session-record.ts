import type { SessionSnapshot } from "../agents/process-manager";
import type { SessionRecordInput } from "../storage/message-store";

/** One persistence mapping for live snapshots, including the selected model. */
export function sessionRecord(snapshot: SessionSnapshot): SessionRecordInput {
  return {
    id: snapshot.id,
    agent: snapshot.agent,
    startedAt: snapshot.startedAt,
    name: snapshot.name,
    npub: snapshot.npub,
    port: snapshot.port,
    pid: snapshot.pid,
    workingDirectory: snapshot.workingDirectory,
    command: snapshot.command,
    runtimeStatus: snapshot.agentRuntimeStatus ?? null,
    origin: snapshot.origin ?? null,
    model: snapshot.model,
    pm2Name: snapshot.pm2Name,
    tmuxSession: snapshot.tmuxSession,
    tmuxWindow: snapshot.tmuxWindow,
    targetFile: snapshot.targetFile,
    tabOrder: snapshot.tabOrder ?? null,
    metadata: snapshot.metadata,
  };
}

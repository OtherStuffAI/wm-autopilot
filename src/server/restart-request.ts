import type { AgentType } from "../config";
import type { ProcessManager, SessionSnapshot } from "../agents/process-manager";
import { createRestartReplacement } from "../sessions/restart-session-policy";
import {
  clearWarmRestartMarker,
  type WarmRestartMarker,
  writeWarmRestartMarker,
} from "./bootstrap/warm-restart";

export interface RestartRequestInput {
  manager: ProcessManager;
  markerPath: string;
  requestedBy?: string | null;
  reason: string;
  isAgentType: (agent: string) => agent is AgentType;
  preflight?: () => Promise<void>;
  launch: (marker: WarmRestartMarker) => Promise<Response>;
}

function activeSessions(manager: ProcessManager): SessionSnapshot[] {
  return manager
    .listSessions()
    .filter((session) => session.status === "starting" || session.status === "running");
}

async function restoreStoppedSessions(
  sessions: SessionSnapshot[],
  input: RestartRequestInput,
): Promise<string[]> {
  const failed: string[] = [];
  for (const session of sessions) {
    try {
      await createRestartReplacement(input.manager, session, input.isAgentType, input.requestedBy);
    } catch {
      failed.push(session.id);
    }
  }
  return failed;
}

export async function scheduleRestartWithSessionRecovery(
  input: RestartRequestInput,
): Promise<Response> {
  try {
    await input.preflight?.();
  } catch (error) {
    return Response.json({
      error: `Restart is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    }, { status: 500 });
  }

  const sessions = activeSessions(input.manager);
  const marker: WarmRestartMarker = {
    createdAt: new Date().toISOString(),
    sessionIds: sessions.map((session) => session.id),
    reason: input.reason,
    version: 3,
    mode: "resume-or-fresh",
    requestedBy: input.requestedBy,
    status: "stopping-sessions",
  };

  try {
    await writeWarmRestartMarker(input.markerPath, marker);
  } catch (error) {
    return Response.json({
      error: `Failed to record sessions for restart: ${error instanceof Error ? error.message : String(error)}`,
    }, { status: 500 });
  }

  const stopped: SessionSnapshot[] = [];
  try {
    for (const session of sessions) {
      await input.manager.stopSession(session.id);
      stopped.push(session);
    }
  } catch (error) {
    const rollbackFailed = await restoreStoppedSessions(stopped, input);
    await clearWarmRestartMarker(input.markerPath);
    return Response.json({
      error: `Failed to stop every session: ${error instanceof Error ? error.message : String(error)}`,
      rollbackFailed,
    }, { status: 500 });
  }

  marker.status = "sessions-stopped";
  try {
    await writeWarmRestartMarker(input.markerPath, marker);
  } catch (error) {
    console.warn(
      `[restart] sessions stopped but marker status update failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const response = await input.launch(marker);
    if (response.ok) return response;
    const rollbackFailed = await restoreStoppedSessions(stopped, input);
    await clearWarmRestartMarker(input.markerPath);
    const payload = await response.clone().json().catch(() => null);
    return Response.json({
      ...(payload && typeof payload === "object" ? payload : { error: "Failed to launch restart" }),
      rollbackFailed,
    }, { status: response.status });
  } catch (error) {
    const rollbackFailed = await restoreStoppedSessions(stopped, input);
    await clearWarmRestartMarker(input.markerPath);
    return Response.json({
      error: `Failed to launch restart: ${error instanceof Error ? error.message : String(error)}`,
      rollbackFailed,
    }, { status: 500 });
  }
}

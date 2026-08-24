import type { CreateJobInput, ScheduledJob, UpdateJobInput } from "./scheduler-store";

export const NATIVE_CLEANUP_JOB_ID = "f60a9b22-9a01-4335-b9cf-dff56dec8805";
export const LEGACY_HEARTBEAT_CLEANUP_MARKER = "FIRST, before any other heartbeat work, always invoke this deterministic cleanup command exactly once";
export const HEARTBEAT_APP_NPUB_MARKER = "--app-npub";

export function buildHeartbeatPrompt(autopilotRoot: string, workspaceRoot: string, appNpub: string): string {
  return `You are being woken up on a one-hour heartbeat.

Heartbeat observes and reports. Autopilot's native scheduled cleanup action owns automatic-session cleanup. Do not run an autosession cleanup CLI or implement a session-stop loop.

Run this bounded Bun-native snapshot first:
bun ${autopilotRoot}/clis/heartbeat-wake.ts --hours 12 --app-npub ${appNpub} --json

Use the configured workspace at ${workspaceRoot}. Review the snapshot for tasks or conversations that may have fallen through the cracks. Do not add comments without evidence or pick up completed work.

Do not interject into, prompt, queue, redirect, stop, or otherwise modify user-created live sessions. Live-session metadata may only be inspected for the report.

When complete, set only this scheduled session's metadata nextAction to stop:
bun ${autopilotRoot}/clis/sessions.ts metadata-update --next-action stop --bot-crypto

Limit the response to the last 12 hours.`;
}

export interface HeartbeatReliabilityStore {
  listJobs(): ScheduledJob[];
  getJob(id: string): ScheduledJob | null;
  updateJob(id: string, input: UpdateJobInput): ScheduledJob | null;
  createJob(input: CreateJobInput & { id?: string }): ScheduledJob;
}

export function reconcileHeartbeatReliabilityDefaults(store: HeartbeatReliabilityStore): string[] {
  const changes: string[] = [];
  const heartbeatId = process.env.WINGMAN_HEARTBEAT_JOB_ID?.trim();
  const autopilotRoot = process.env.WINGMAN_AUTOPILOT_ROOT?.trim();
  const workspaceRoot = process.env.WINGMAN_HEARTBEAT_WORKSPACE?.trim();
  const appNpub = process.env.WINGMAN_HEARTBEAT_APP_NPUB?.trim();
  const heartbeat = heartbeatId ? store.getJob(heartbeatId) : null;
  const promptNeedsReliabilityUpdate = heartbeat
    && (heartbeat.initialPrompt.includes(LEGACY_HEARTBEAT_CLEANUP_MARKER)
      || !heartbeat.initialPrompt.includes(HEARTBEAT_APP_NPUB_MARKER));
  if (promptNeedsReliabilityUpdate && autopilotRoot && workspaceRoot && appNpub) {
    store.updateJob(heartbeat.id, { initialPrompt: buildHeartbeatPrompt(autopilotRoot, workspaceRoot, appNpub) });
    changes.push("heartbeat-prompt-v3");
  }

  const existingCleanup = store.getJob(NATIVE_CLEANUP_JOB_ID)
    ?? store.listJobs().find((job) => job.actionType === "cleanup" && job.name === "Close out sessions")
    ?? null;
  if (existingCleanup) {
    if (!existingCleanup.enabled || existingCleanup.cronExpression !== "*/15 * * * *") {
      store.updateJob(existingCleanup.id, { enabled: true, cronExpression: "*/15 * * * *" });
      changes.push("native-cleanup-enabled");
    }
  } else if (heartbeat) {
    store.createJob({
      id: NATIVE_CLEANUP_JOB_ID,
      name: "Close out sessions",
      userNpub: heartbeat.userNpub,
      botNpub: "",
      wrappedKeyCiphertext: "",
      wrappedKeyNonce: "",
      agent: "codex",
      workingDirectory: "",
      initialPrompt: "",
      nightwatchmanEnabled: false,
      triggerType: "cron",
      cronExpression: "*/15 * * * *",
      timezone: heartbeat.timezone,
      actionType: "cleanup",
    });
    changes.push("native-cleanup-created");
  }
  return changes;
}

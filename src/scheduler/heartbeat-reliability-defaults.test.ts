import { describe, expect, test } from "bun:test";
import {
  LEGACY_HEARTBEAT_CLEANUP_MARKER,
  NATIVE_CLEANUP_JOB_ID,
  buildHeartbeatPrompt,
  reconcileHeartbeatReliabilityDefaults,
} from "./heartbeat-reliability-defaults";

function job(overrides: any) {
  return { id: "id", name: "job", initialPrompt: "", actionType: "session", enabled: true, cronExpression: "0 * * * *", userNpub: "npub1owner", timezone: "UTC", ...overrides } as any;
}

describe("heartbeat reliability defaults", () => {
  test("removes owner cleanup from heartbeat and enables native cleanup", () => {
    const heartbeatId = "heartbeat-job";
    process.env.WINGMAN_HEARTBEAT_JOB_ID = heartbeatId;
    process.env.WINGMAN_AUTOPILOT_ROOT = "/opt/wingman/autopilot";
    process.env.WINGMAN_HEARTBEAT_WORKSPACE = "/srv/workspace";
    process.env.WINGMAN_HEARTBEAT_APP_NPUB = "npub1flightdeck";
    const jobs = new Map([
      [heartbeatId, job({ id: heartbeatId, initialPrompt: `run ${LEGACY_HEARTBEAT_CLEANUP_MARKER}` })],
      [NATIVE_CLEANUP_JOB_ID, job({ id: NATIVE_CLEANUP_JOB_ID, name: "Close out sessions", actionType: "cleanup", enabled: false, cronExpression: "0 * * * *" })],
    ]);
    const changes = reconcileHeartbeatReliabilityDefaults({
      listJobs: () => [...jobs.values()],
      getJob: (id) => jobs.get(id) ?? null,
      updateJob: (id, update) => Object.assign(jobs.get(id)!, update),
      createJob: (input) => { const created = job(input); jobs.set(created.id, created); return created; },
    });
    expect(changes).toEqual(["heartbeat-prompt-v3", "native-cleanup-enabled"]);
    const prompt = buildHeartbeatPrompt("/opt/wingman/autopilot", "/srv/workspace", "npub1flightdeck");
    expect(jobs.get(heartbeatId)?.initialPrompt).toBe(prompt);
    expect(prompt).not.toContain(LEGACY_HEARTBEAT_CLEANUP_MARKER);
    expect(prompt).toContain("--app-npub npub1flightdeck");
    expect(jobs.get(NATIVE_CLEANUP_JOB_ID)).toMatchObject({ enabled: true, cronExpression: "*/15 * * * *", actionType: "cleanup" });
  });
});

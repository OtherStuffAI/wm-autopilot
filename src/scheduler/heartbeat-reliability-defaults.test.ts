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
    expect(changes).toEqual(["heartbeat-prompt-v5", "native-cleanup-enabled"]);
    const prompt = buildHeartbeatPrompt("/opt/wingman/autopilot", "/srv/workspace", "npub1flightdeck");
    expect(jobs.get(heartbeatId)?.initialPrompt).toBe(prompt);
    expect(prompt).not.toContain(LEGACY_HEARTBEAT_CLEANUP_MARKER);
    expect(prompt).toContain("--app-npub npub1flightdeck");
    expect(jobs.get(NATIVE_CLEANUP_JOB_ID)).toMatchObject({ enabled: true, cronExpression: "*/15 * * * *", actionType: "cleanup" });
  });
});

test("upgrades existing v4 once and reserves sync budget while requiring every review page", () => {
  const heartbeatId = process.env.WINGMAN_HEARTBEAT_JOB_ID!;
  const heartbeat = job({ id: heartbeatId, initialPrompt: "record-sync v2 --app-npub app" });
  const cleanup = job({ id: NATIVE_CLEANUP_JOB_ID, actionType: "cleanup", cronExpression: "*/15 * * * *" });
  const jobs = new Map([[heartbeatId, heartbeat], [NATIVE_CLEANUP_JOB_ID, cleanup]]);
  const store = {
    listJobs: () => [...jobs.values()],
    getJob: (id: string) => jobs.get(id) ?? null,
    updateJob: (id: string, update: any) => Object.assign(jobs.get(id)!, update),
    createJob: (input: any) => job(input),
  };
  expect(reconcileHeartbeatReliabilityDefaults(store)).toEqual(["heartbeat-prompt-v5"]);
  expect(reconcileHeartbeatReliabilityDefaults(store)).toEqual([]);
  expect(heartbeat.initialPrompt).toContain("--max-time-ms 60000 --max-pages 10");
  expect(heartbeat.initialPrompt).toContain("--review-only --review-cursor");
  expect(heartbeat.initialPrompt).toContain("nextCursor=null");
  expect(heartbeat.initialPrompt).toContain("Never claim all records reviewed from the first 200 rows");
  expect(heartbeat.initialPrompt).toContain("dedicated --catch-up work to Rick");
});

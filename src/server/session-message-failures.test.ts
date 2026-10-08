import { describe, expect, test } from "bun:test";

import type { SessionSnapshot } from "../agents/process-manager";
import { normalizeBusySessionMessageFailure } from "./session-message-failures";

const baseSession: SessionSnapshot = {
  id: "session-1",
  agent: "codex",
  status: "running",
  npub: "npub1owner",
  port: 3700,
  pid: 1234,
  name: "test session",
  startedAt: new Date().toISOString(),
  command: ["codex"],
  workingDirectory: "/tmp/project",
  logs: [],
  agentRuntimeStatus: "stable",
  origin: undefined,
  pm2Name: undefined,
  targetFile: undefined,
  metadata: { AGENT: false, billingMode: "subscription" },
};

describe("normalizeBusySessionMessageFailure", () => {
  test("maps generic 5xx delivery failures to busy while the adapter still reports running", async () => {
    const result = await normalizeBusySessionMessageFailure(
      baseSession,
      { certainty: "rejected", ok: false, status: 500, message: "Internal Server Error" },
      { fetchStatus: async () => "running" } as any,
    );

    expect(result).toEqual({
      certainty: "rejected",
      ok: false,
      status: 409,
      message: "Agent working",
    });
  });

  test("preserves generic 5xx delivery failures once the runtime is stable", async () => {
    const result = await normalizeBusySessionMessageFailure(
      baseSession,
      { certainty: "rejected", ok: false, status: 500, message: "Internal Server Error" },
      { fetchStatus: async () => "stable" } as any,
    );

    expect(result).toEqual({
      certainty: "rejected",
      ok: false,
      status: 500,
      message: "Internal Server Error",
    });
  });
});

test("uncertain delivery is never converted into a retryable busy rejection", async () => {
  const failure = { certainty: "uncertain" as const, ok: false, status: 502, message: "Failed to contact agent" };
  expect(await normalizeBusySessionMessageFailure(baseSession, failure, { fetchStatus: async () => "running" } as any)).toEqual(failure);
});

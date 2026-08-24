import { describe, expect, test } from "bun:test";

import { resolveNativeResumeLaunch } from "./native-resume-launch";

const isAgentType = (agent: string): agent is "codex" => agent === "codex";

describe("resolveNativeResumeLaunch", () => {
  test("builds a native resume launch while preserving ownership", () => {
    const launch = resolveNativeResumeLaunch({
      id: "session-old",
      agent: "codex",
      name: "Update Autopilot",
      npub: "npub1owner",
      workingDirectory: "/tmp/project",
      metadata: {
        ownerNpub: "npub1owner",
        nativeAgentSession: {
          agent: "codex",
          sessionId: "native-123",
          workingDirectory: "/tmp/project",
        },
      },
    }, isAgentType, "npub1wingman");

    expect(launch.agent).toBe("codex");
    expect(launch.name).toBe("Update Autopilot (resumed)");
    expect(launch.origin).toEqual({
      type: "native-resume",
      id: "session-old",
      label: "Native resume from Update Autopilot",
    });
    expect(launch.metadata.nativeAgentSession?.sessionId).toBe("native-123");
    expect(launch.metadata.resumedFromWingmanSessionId).toBe("session-old");
    expect(launch.metadata.ownerNpub).toBe("npub1owner");
    expect(launch.metadata.lastManagedByNpub).toBe("npub1wingman");
  });

  test("rejects a session before shutdown when its native id is missing", () => {
    expect(() => resolveNativeResumeLaunch({
      id: "session-old",
      agent: "codex",
      name: "No native id",
      npub: null,
      workingDirectory: "/tmp/project",
      metadata: {},
    }, isAgentType)).toThrow("native agent session id");
  });
});

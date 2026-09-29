import { describe, expect, test } from "bun:test";
import type { SessionSnapshot } from "../agents/process-manager";
import { recoverStoppedAutoSessionArchives } from "./stopped-session-recovery";

function session(id: string, status: SessionSnapshot["status"], automatic = true): SessionSnapshot {
  return {
    id, agent: "codex", port: 3700, name: id, status, startedAt: "2026-09-29T00:00:00.000Z",
    command: [], workingDirectory: "/tmp", logs: [], metadata: { AGENT: automatic, billingMode: "subscription" },
  };
}

describe("recoverStoppedAutoSessionArchives", () => {
  test("archives a formerly protected stopped session after its turn releases it", () => {
    const sessions = [session("old-chat", "stopped"), session("active-chat", "running"), session("manual", "stopped", false)];
    const scheduled: string[] = [];
    let protectedSession = true;
    const recover = () => recoverStoppedAutoSessionArchives(
      sessions, (id) => id === "old-chat" && protectedSession, (id) => scheduled.push(id),
    );

    expect(recover()).toEqual([]);
    protectedSession = false;
    expect(recover()).toEqual(["old-chat"]);
    expect(scheduled).toEqual(["old-chat"]);
  });
});

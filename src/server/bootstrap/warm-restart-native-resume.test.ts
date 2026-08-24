import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { restoreRestartedSessions } from "./warm-restart";

describe("restoreRestartedSessions", () => {
  test("creates replacement sessions from the durable restart marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "wingman-native-resume-"));
    const markerPath = join(root, "restart.json");
    await writeFile(markerPath, "{}\n", "utf8");
    const launches: unknown[][] = [];
    const manager = {
      createSession: async (...args: unknown[]) => {
        launches.push(args);
        return { id: "session-new" };
      },
    };
    const store = {
      listSessions: () => [{
        id: "session-old",
        agent: "codex",
        name: "Release work",
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
      }],
      listSessionMessages: () => [
        {
          id: "message-1",
          sessionId: "session-old",
          role: "user",
          content: "Keep the release work moving",
          createdAt: "2026-08-17T00:00:00.000Z",
          messageId: "native-message-1",
          turnId: "turn-1",
          order: 1,
        },
      ],
      replaceMessages: (sessionId: string, messages: unknown[]) => {
        expect(sessionId).toBe("session-new");
        expect(messages).toEqual([{
          role: "user",
          content: "Keep the release work moving",
          createdAt: "2026-08-17T00:00:00.000Z",
          messageId: "native-message-1",
          turnId: "turn-1",
          order: 1,
        }]);
      },
    };

    const outcome = await restoreRestartedSessions({
      createdAt: new Date().toISOString(),
      mode: "native-resume",
      sessionIds: ["session-old"],
      requestedBy: "npub1wingman",
    }, markerPath, manager as never, store as never, ["codex"]);

    expect(outcome).toMatchObject({
      restored: 1,
      failed: [],
      mode: "native-resume",
      resumedSessions: [{ sourceSessionId: "session-old", sessionId: "session-new" }],
    });
    expect(launches).toHaveLength(1);
    expect(launches[0]?.[0]).toBe("codex");
    expect(launches[0]?.[2]).toBe("Release work (resumed)");
    expect(await Bun.file(markerPath).exists()).toBe(false);
  });

  test("records missing source sessions without preventing other resumes", async () => {
    const outcome = await restoreRestartedSessions({
      createdAt: new Date().toISOString(),
      mode: "native-resume",
      sessionIds: ["missing"],
    }, join(tmpdir(), `missing-restart-${crypto.randomUUID()}.json`), {
      createSession: async () => ({ id: "unused" }),
    } as never, {
      listSessions: () => [],
      listSessionMessages: () => [],
      replaceMessages: () => undefined,
    } as never, ["codex"]);

    expect(outcome).toMatchObject({ restored: 0, failed: ["missing"] });
  });

  test("starts a fresh replacement when native resume metadata is missing", async () => {
    const launches: unknown[][] = [];
    const outcome = await restoreRestartedSessions({
      createdAt: new Date().toISOString(),
      mode: "resume-or-fresh",
      sessionIds: ["session-old"],
    }, join(tmpdir(), `fresh-restart-${crypto.randomUUID()}.json`), {
      createSession: async (...args: unknown[]) => {
        launches.push(args);
        return { id: "session-fresh" };
      },
    } as never, {
      listSessions: () => [{
        id: "session-old",
        agent: "codex",
        name: "Uncaptured work",
        npub: "npub1owner",
        workingDirectory: "/tmp/project",
        metadata: { ownerNpub: "npub1owner" },
      }],
      listSessionMessages: () => [{
        id: "message-1",
        sessionId: "session-old",
        role: "assistant",
        content: "Existing progress",
        createdAt: "2026-08-17T00:00:00.000Z",
      }],
      replaceMessages: (sessionId: string, messages: unknown[]) => {
        expect(sessionId).toBe("session-fresh");
        expect(messages).toEqual([{
          role: "assistant",
          content: "Existing progress",
          createdAt: "2026-08-17T00:00:00.000Z",
        }]);
      },
    } as never, ["codex"]);

    expect(outcome).toMatchObject({
      restored: 1,
      failed: [],
      mode: "resume-or-fresh",
      resumedSessions: [],
      freshSessions: [{
        sourceSessionId: "session-old",
        sessionId: "session-fresh",
        reason: "Session does not have a native agent session id to resume",
      }],
    });
    expect(launches[0]?.[2]).toBe("Uncaptured work (fresh restart)");
    expect(launches[0]?.[3]).toMatchObject({ type: "restart-fresh", id: "session-old" });
    expect((launches[0]?.[6] as { nativeAgentSession?: unknown }).nativeAgentSession).toBeUndefined();
  });

  test("starts fresh when a captured native session can no longer load", async () => {
    const origins: string[] = [];
    const outcome = await restoreRestartedSessions({
      createdAt: new Date().toISOString(),
      mode: "resume-or-fresh",
      sessionIds: ["session-old"],
    }, join(tmpdir(), `failed-native-restart-${crypto.randomUUID()}.json`), {
      createSession: async (...args: unknown[]) => {
        const origin = args[3] as { type: string };
        origins.push(origin.type);
        if (origin.type === "native-resume") throw new Error("thread missing");
        return { id: "session-fresh" };
      },
    } as never, {
      listSessions: () => [{
        id: "session-old",
        agent: "codex",
        name: "Release work",
        npub: "npub1owner",
        workingDirectory: "/tmp/project",
        metadata: {
          nativeAgentSession: {
            agent: "codex",
            sessionId: "native-123",
            workingDirectory: "/tmp/project",
          },
        },
      }],
      listSessionMessages: () => [],
      replaceMessages: () => undefined,
    } as never, ["codex"]);

    expect(origins).toEqual(["native-resume", "restart-fresh"]);
    expect(outcome?.freshSessions?.[0]?.reason).toBe("Native resume failed: thread missing");
  });
});

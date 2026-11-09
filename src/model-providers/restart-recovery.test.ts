import { expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { restoreRestartedSessions } from "../server/bootstrap/warm-restart";

test("Tinfoil restart creates fresh credential-bearing runner and copies transcript with exact model", async () => {
  const launches: unknown[][] = [];
  let transcript: unknown[] = [];
  const outcome = await restoreRestartedSessions({ createdAt: new Date().toISOString(), mode: "resume-or-fresh", sessionIds: ["old"] },
    join(tmpdir(), `tinfoil-recovery-${crypto.randomUUID()}.json`), {
      createSession: async (...args: unknown[]) => { launches.push(args); return { id: "new" }; },
    } as never, {
      listSessions: () => [{ id: "old", agent: "pi", name: "Work", npub: "owner", workingDirectory: "/tmp/project", model: "tinfoil/kimi-k3-1-pro",
        metadata: { modelProvider: "tinfoil", modelProviderWorkspaceId: "local", nativeAgentSession: { agent: "pi", sessionId: "native-old", workingDirectory: "/tmp/project" } } }],
      listSessionMessages: () => [{ id: "message", role: "assistant", content: "Previous progress", createdAt: "2026-01-01T00:00:00.000Z" }],
      replaceMessages: (_id: string, messages: unknown[]) => { transcript = messages; },
    } as never, ["pi"]);
  expect(outcome?.restored).toBe(1);
  expect(outcome?.freshSessions?.[0]?.reason).toContain("renews session credentials");
  expect(launches).toHaveLength(1);
  expect(launches[0]![7]).toBe("tinfoil/kimi-k3-1-pro");
  expect(launches[0]![6]).toMatchObject({ modelProvider: "tinfoil", modelProviderWorkspaceId: "local" });
  expect((launches[0]![6] as any).nativeAgentSession).toBeUndefined();
  expect(transcript).toMatchObject([{ role: "assistant", content: "Previous progress" }]);
});

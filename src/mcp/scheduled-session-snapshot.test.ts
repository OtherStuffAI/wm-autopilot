import { expect, test } from "bun:test";
import { scheduledSessionSnapshot } from "./scheduled-session-snapshot";
import type { SessionSnapshot } from "../agents/process-manager";

test("scheduled caller snapshot exposes binding fields and excludes unrelated private metadata", () => {
  const session = { id: "self", npub: "owner", origin: { type: "scheduler", id: "job" }, metadata: {
    agentChatBotNpub: "bot", flightdeckWorkspaceId: "workspace", privateUnrelatedValue: "omit", goal: "omit",
  } } as unknown as SessionSnapshot;
  expect(scheduledSessionSnapshot(session)).toMatchObject({ id: "self", npub: "owner", origin: { type: "scheduler", id: "job" },
    metadata: { agentChatBotNpub: "bot", flightdeckWorkspaceId: "workspace" } });
  expect(scheduledSessionSnapshot(session)!.metadata).not.toHaveProperty("privateUnrelatedValue");
  expect(scheduledSessionSnapshot({ ...session, origin: { type: "manual", id: "manual" } })).toBeNull();
});

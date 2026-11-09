import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MessageStore } from "../storage/message-store";
import { sessionRecord } from "./session-record";
import type { SessionSnapshot } from "../agents/process-manager";

test("live session persistence preserves provider/model across lifecycle updates", () => {
  const root = mkdtempSync(join(tmpdir(), "wm-session-record-"));
  const store = new MessageStore(join(root, "messages.sqlite"));
  const snapshot = { id: "test", agent: "pi", status: "running", startedAt: new Date().toISOString(), port: 1, name: "Test", workingDirectory: root,
    command: ["pi"], logs: [], model: "tinfoil/kimi-k3-1-pro", metadata: { AGENT: false, billingMode: "subscription", modelProvider: "tinfoil", modelProviderWorkspaceId: "local" } } as SessionSnapshot;
  try {
    store.recordSession(sessionRecord(snapshot));
    store.recordSession(sessionRecord({ ...snapshot, name: "Updated" }));
    expect(store.getSession("test")?.model).toBe("tinfoil/kimi-k3-1-pro");
    expect(store.getSession("test")?.metadata?.modelProvider).toBe("tinfoil");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

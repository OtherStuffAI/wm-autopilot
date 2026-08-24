import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const projectRoot = join(import.meta.dir, "../..");

describe("relay work trigger removal", () => {
  test("server startup and bot-key unlock wiring retain only access-grant onboarding", () => {
    const serverSource = readFileSync(join(projectRoot, "src/server.ts"), "utf8");
    const unlockHook = serverSource.match(
      /function onBotKeyUnlockedHook[\s\S]*?\n\}/,
    )?.[0] ?? "";

    expect(serverSource).not.toContain("9802");
    expect(serverSource).not.toContain("9256");
    expect(serverSource).not.toContain("startTaskListener");
    expect(serverSource).not.toContain("createTriggerListener");
    expect(serverSource).not.toContain("executeJobWithMessage");
    expect(serverSource).toContain("accessGrantListener.subscribe(adminNpub");
    expect(unlockHook).toContain("accessGrantListener?.subscribe");
    expect(unlockHook).not.toContain("createSession");
    expect(unlockHook).not.toContain("addPrompt");
    expect(unlockHook).not.toContain("dispatchPrompt");
  });

  test("obsolete relay listener and executor modules are absent", () => {
    for (const relativePath of [
      "src/nostr/task-listener.ts",
      "src/nostr/task-executor.ts",
      "src/nostr/trigger-listener.ts",
    ]) {
      expect(existsSync(join(projectRoot, relativePath))).toBe(false);
    }
  });
});

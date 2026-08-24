import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const serverSource = readFileSync(new URL("../../server.ts", import.meta.url), "utf8");

describe("warm restart startup order", () => {
  test("initializes prompt dispatch before restoring sessions", () => {
    const callbackMigration = serverSource.indexOf("sessionDispatchInbox.migrateLegacyCallbacks(promptQueueStore)");
    const dispatchInitialization = serverSource.indexOf("const promptDispatchEngine = createPromptDispatchEngine");
    const dispatchDestructure = serverSource.indexOf("} = promptDispatchEngine;");
    const restartRecovery = serverSource.indexOf("await restoreRestartedSessions(");
    const preservedRecovery = serverSource.indexOf("await rehydrateWarmSessions(");

    expect(dispatchInitialization).toBeGreaterThan(-1);
    expect(callbackMigration).toBeGreaterThan(-1);
    expect(dispatchInitialization).toBeGreaterThan(callbackMigration);
    expect(dispatchDestructure).toBeGreaterThan(dispatchInitialization);
    expect(restartRecovery).toBeGreaterThan(dispatchDestructure);
    expect(preservedRecovery).toBeGreaterThan(dispatchDestructure);
  });
});

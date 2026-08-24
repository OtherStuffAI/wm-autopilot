import { describe, expect, mock, test } from "bun:test";

import {
  restoreStartupIdentity,
  runStartupStepWithTimeout,
} from "./auth-startup.js";

describe("auth startup", () => {
  test("continues when a startup step times out", async () => {
    const result = await runStartupStepWithTimeout(
      "Slow auth step",
      () => new Promise(() => {}),
      { timeoutMs: 1 },
    );

    expect(result.status).toBe("timed-out");
    expect(result.label).toBe("Slow auth step");
  });

  test("checks key teleport only when still logged out", async () => {
    let authenticated = false;
    const restoreFromDeviceKeystore = mock(async () => {
      authenticated = true;
      return "npub1test";
    });
    const checkKeyTeleportParam = mock(async () => "teleport");

    const results = await restoreStartupIdentity({
      identityApi: { restoreFromDeviceKeystore, checkKeyTeleportParam },
      getIdentityWiringContext: () => ({ state: {} }),
      isAuthenticated: () => authenticated,
      timeoutMs: 5,
      logger: { log() {}, warn() {} },
    });

    expect(results).toHaveLength(1);
    expect(restoreFromDeviceKeystore).toHaveBeenCalledTimes(1);
    expect(checkKeyTeleportParam).not.toHaveBeenCalled();
  });

  test("records restore failures and still checks key teleport", async () => {
    const restoreFromDeviceKeystore = mock(async () => {
      throw new Error("restore failed");
    });
    const checkKeyTeleportParam = mock(async () => null);
    const warn = mock(() => {});

    const results = await restoreStartupIdentity({
      identityApi: { restoreFromDeviceKeystore, checkKeyTeleportParam },
      getIdentityWiringContext: () => ({}),
      isAuthenticated: () => false,
      timeoutMs: 5,
      logger: { log() {}, warn },
    });

    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
    expect(checkKeyTeleportParam).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

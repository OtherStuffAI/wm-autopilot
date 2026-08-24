import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { CaproverStore } from "./caprover-store";

let tempDir: string | null = null;

function createTempStore(): CaproverStore {
  tempDir = mkdtempSync(join(tmpdir(), "caprover-store-"));
  return new CaproverStore(join(tempDir, "store.sqlite"));
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("CaproverStore deployment targets", () => {
  test("updates tracked CapRover app name for relinking", () => {
    const store = createTempStore();
    const app = store.createApp({
      caproverName: "old-app",
      appId: "local-demo",
    });

    const updated = store.updateApp(app.id, {
      caproverName: "new-app",
      liveUrl: "https://new-app.example.test",
    });

    expect(updated.caproverName).toBe("new-app");
    expect(updated.liveUrl).toBe("https://new-app.example.test");
    expect(store.getAppByCaproverName("new-app")?.appId).toBe("local-demo");
  });

  test("records target name on deployments", () => {
    const store = createTempStore();
    const app = store.createApp({
      caproverName: "demo-app",
      appId: "local-demo",
    });

    const deployment = store.createDeployment({
      caproverAppId: app.id,
      targetName: "secondary",
      deployMethod: "tar_upload",
    });

    expect(deployment.targetName).toBe("secondary");
    expect(store.getDeployment(deployment.id)?.targetName).toBe("secondary");
  });
});

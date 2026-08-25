import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import {
  consumeAppRuntimeEnvelope,
  createAppRuntimeEnvelope,
} from "./app-runtime-envelope";

describe("managed app runtime environment envelopes", () => {
  test("hands app-specific environment to the runner once", async () => {
    const directory = mkdtempSync(join(tmpdir(), "app-runtime-envelope-"));
    try {
      const reference = await createAppRuntimeEnvelope(directory, "app-1", {
        API_TOKEN: "app-secret",
      });

      expect(await Bun.file(reference.path).text()).not.toContain("app-secret");
      await expect(consumeAppRuntimeEnvelope(reference, "app-1")).resolves.toEqual({
        API_TOKEN: "app-secret",
      });
      expect(await Bun.file(reference.path).exists()).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects an envelope bound to another app and consumes it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "app-runtime-envelope-"));
    try {
      const reference = await createAppRuntimeEnvelope(directory, "app-1", {});
      await expect(consumeAppRuntimeEnvelope(reference, "app-2")).rejects.toThrow("does not match");
      expect(await Bun.file(reference.path).exists()).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

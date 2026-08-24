import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FeatureFlagStore } from "./feature-flag-store";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "wingman-feature-flags-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const createStore = () => new FeatureFlagStore(join(tempDir, "feature-flags.sqlite"));

describe("FeatureFlagStore", () => {
  test("updates untouched default flags to a new default state", () => {
    const store = createStore();
    store.ensureDefaults([
      {
        key: "codex-use-native-sdk",
        label: "Codex Native SDK",
        state: "off",
      },
    ]);

    const updated = store.ensureDefaultState("codex-use-native-sdk", "on");

    expect(updated?.state).toBe("on");
    expect(updated?.updatedBy).toBeNull();
    expect(store.getFlag("codex-use-native-sdk")?.state).toBe("on");
  });

  test("can move an untouched shipped flag back off", () => {
    const store = createStore();
    store.ensureDefaults([
      {
        key: "codex-use-native-sdk",
        label: "Codex Native SDK",
        state: "on",
      },
    ]);

    const updated = store.ensureDefaultState("codex-use-native-sdk", "off");

    expect(updated?.state).toBe("off");
    expect(updated?.updatedBy).toBeNull();
    expect(store.getFlag("codex-use-native-sdk")?.state).toBe("off");
  });

  test("does not update user-managed feature flags", () => {
    const store = createStore();
    store.createFlag({
      key: "codex-use-native-sdk",
      label: "Codex Native SDK",
      state: "off",
      updatedBy: "npub1user",
    });

    const updated = store.ensureDefaultState("codex-use-native-sdk", "on");

    expect(updated?.state).toBe("off");
    expect(updated?.updatedBy).toBe("npub1user");
    expect(store.getFlag("codex-use-native-sdk")?.state).toBe("off");
  });
});

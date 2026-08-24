import { describe, expect, test } from "bun:test";

import type { RequestAuthContext } from "../auth/request-context";
import type { FeatureFlagRecord } from "../storage/feature-flag-store";
import { handleFeatureFlagsApi, serialiseFeatureFlagsForViewer } from "./feature-flags-routes";

const retiredFlag: FeatureFlagRecord = {
  key: "task_listener_enabled",
  label: "MG Task Listener",
  description: "historical row",
  state: "on",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  updatedBy: null,
};

describe("retired feature flags", () => {
  test("keeps historical rows inert and out of Settings/config serialization", () => {
    const flags = serialiseFeatureFlagsForViewer({
      listFlags: () => [retiredFlag, { ...retiredFlag, key: "active_flag", label: "Active" }],
      createFlag: () => retiredFlag,
      updateFlag: () => retiredFlag,
    }, true);
    expect(flags.map((flag) => flag.key)).toEqual(["active_flag"]);
  });

  test("rejects attempts to recreate the retired operative key", async () => {
    const request = new Request("http://wingman.test/api/feature-flags", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: retiredFlag.key, label: retiredFlag.label, state: "on" }),
    });
    const authContext = { npub: "npub-admin" } as RequestAuthContext;
    const response = await handleFeatureFlagsApi(request, new URL(request.url), "POST", authContext, {
      featureFlagStore: {
        listFlags: () => [retiredFlag],
        createFlag: () => retiredFlag,
        updateFlag: () => retiredFlag,
      },
      viewerIsAdmin: true,
      ensureApiAccess: async () => null,
      AccessActions: { FeatureFlagsManage: "feature-flags:manage" as never },
    });
    expect(response?.status).toBe(410);
    expect(await response?.json()).toEqual({ error: "This feature flag is retired and has no runtime effect" });
  });
});

import { describe, expect, test } from "bun:test";

import { buildAppPm2EnvironmentBoundary } from "./app-pm2-environment";

describe("managed app PM2 environment boundary", () => {
  test("allows runtime essentials and filters every other inherited host key", () => {
    const boundary = buildAppPm2EnvironmentBoundary({
      PATH: "/runtime/bin",
      HOME: "/runtime/home",
      LANG: "en_AU.UTF-8",
      APP_ID: "parent-app",
      WINGMAN_PROCESS_KIND: "parent-kind",
      IDENTITY_SESSION_SECRET: "session-secret",
      WINGMEN_PIPELINE_HTTP_TRIGGER_TOKEN: "pipeline-secret",
      WINGMAN_CAPABILITY: "agent-capability",
      RANDOM_FUTURE_SECRET: "future-secret",
    });

    expect(boundary.env).toEqual({
      PATH: "/runtime/bin",
      HOME: "/runtime/home",
      LANG: "en_AU.UTF-8",
    });
    expect(boundary.filteredParentKeys).toContain("IDENTITY_SESSION_SECRET");
    expect(boundary.filteredParentKeys).toContain("WINGMEN_PIPELINE_HTTP_TRIGGER_TOKEN");
    expect(boundary.filteredParentKeys).toContain("WINGMAN_CAPABILITY");
    expect(boundary.filteredParentKeys).toContain("RANDOM_FUTURE_SECRET");
    expect(boundary.filteredParentKeys).not.toContain("APP_ID");
    expect(boundary.filteredParentKeys).not.toContain("WINGMAN_PROCESS_KIND");
  });
});

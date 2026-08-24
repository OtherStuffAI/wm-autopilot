import { describe, expect, test } from "bun:test";

import { buildAutosessionCleanupRoutes } from "./autosession-cleanup-routes";

describe("autosession cleanup routes", () => {
  test("keeps operator cleanup in self space", () => {
    const routes = buildAutosessionCleanupRoutes();

    expect(routes.collectionPath).toBe("/api/sessions");
    expect(routes.sessionPath("session/id")).toBe("/api/sessions/session%2Fid");
  });

  test("uses delegated owner space for bot-crypto cleanup", () => {
    const routes = buildAutosessionCleanupRoutes("npub1owner");

    expect(routes.collectionPath).toBe("/api/owners/npub1owner/sessions");
    expect(routes.sessionPath("session/id")).toBe(
      "/api/owners/npub1owner/sessions/session%2Fid",
    );
  });
});

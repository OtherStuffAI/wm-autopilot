import { describe, expect, test } from "bun:test";

import type { LegacyWappCustodyMigration } from "../wapps/legacy-custody-migration";
import {
  WAPP_LEGACY_CUSTODY_MIGRATION_PATH,
  handleWappLegacyCustodyMigrationRoute,
} from "./wapp-legacy-custody-migration-route";

describe("WApp legacy custody migration route", () => {
  test("requires loopback, Admin authority, POST, and forwards only the non-secret request", async () => {
    const calls: unknown[] = [];
    const migration = {
      migrate: async (input: unknown) => {
        calls.push(input);
        return {
          dryRun: true,
          appId: "app-1",
          installationId: "installation-1",
          appNpub: "npub1public",
        };
      },
    } as unknown as LegacyWappCustodyMigration;
    const body = {
      appId: "app-1",
      sourceEnvFile: "/apps/kindling/.env",
      expectedAppNpub: "npub1public",
      towerBindingId: "tower-1",
      installation: {},
    };
    const invoke = (overrides: Partial<Parameters<typeof handleWappLegacyCustodyMigrationRoute>[0]> = {}) => {
      const request = new Request(`http://127.0.0.1:3000${WAPP_LEGACY_CUSTODY_MIGRATION_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return handleWappLegacyCustodyMigrationRoute({
        request,
        url: new URL(request.url),
        method: "POST",
        isLoopback: true,
        isAdmin: true,
        migration,
        ...overrides,
      });
    };
    expect((await invoke({ isLoopback: false }))?.status).toBe(403);
    expect((await invoke({ isAdmin: false }))?.status).toBe(403);
    expect((await invoke({ method: "GET" }))?.status).toBe(405);
    expect(calls).toEqual([]);

    const response = await invoke();
    expect(response?.status).toBe(200);
    expect(calls).toEqual([body]);
    expect(JSON.stringify(await response?.json())).not.toContain("WAPP_NSEC");
  });

  test("does not reflect unexpected failure details", async () => {
    const secret = "nsec1must-never-be-reflected";
    const migration = {
      migrate: async () => { throw new Error(secret); },
    } as unknown as LegacyWappCustodyMigration;
    const request = new Request(`http://127.0.0.1:3000${WAPP_LEGACY_CUSTODY_MIGRATION_PATH}`, {
      method: "POST",
      body: "{}",
    });
    const response = await handleWappLegacyCustodyMigrationRoute({
      request,
      url: new URL(request.url),
      method: "POST",
      isLoopback: true,
      isAdmin: true,
      migration,
    });
    expect(response?.status).toBe(500);
    expect(await response?.text()).not.toContain(secret);
  });
});

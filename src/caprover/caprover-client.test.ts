import { describe, expect, test } from "bun:test";

import { createCaproverTargetClientsFromEnv } from "./caprover-client";

describe("createCaproverTargetClientsFromEnv", () => {
  test("keeps existing single CapRover env as primary", () => {
    const targets = createCaproverTargetClientsFromEnv({
      CAPROVER_URL: "https://captain.example.com",
      LOGIN_CODE: "secret",
    });

    expect(targets.map((target) => target.name)).toEqual(["primary"]);
    expect(targets[0]?.serverUrl).toBe("https://captain.example.com");
  });

  test("adds secondary target when secondary env is configured", () => {
    const targets = createCaproverTargetClientsFromEnv({
      CAPROVER_URL: "https://captain-primary.example.com",
      LOGIN_CODE: "primary-secret",
      CAPROVER_SECONDARY_URL: "https://captain-secondary.example.com",
      CAPROVER_SECONDARY_LOGIN_CODE: "secondary-secret",
    });

    expect(targets.map((target) => target.name)).toEqual(["primary", "secondary"]);
    expect(targets.map((target) => target.serverUrl)).toEqual([
      "https://captain-primary.example.com",
      "https://captain-secondary.example.com",
    ]);
  });

  test("supports explicit target lists with target-specific env vars", () => {
    const targets = createCaproverTargetClientsFromEnv({
      CAPROVER_TARGETS: "primary, backup",
      CAPROVER_URL: "https://captain-primary.example.com",
      LOGIN_CODE: "primary-secret",
      CAPROVER_BACKUP_URL: "https://captain-backup.example.com",
      CAPROVER_BACKUP_PASSWORD: "backup-secret",
    });

    expect(targets.map((target) => target.name)).toEqual(["primary", "backup"]);
  });
});

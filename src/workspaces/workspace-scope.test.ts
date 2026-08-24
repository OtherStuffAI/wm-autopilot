import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { randomUUID } from "node:crypto";

import type { WingmanConfig } from "../config";
import type { RequestAuthContext } from "../auth/request-context";
import { resolveWorkspaceScope } from "./workspace-scope";

const createConfig = (workspaceRoot: string): WingmanConfig => ({
  defaultWorkingDirectory: workspaceRoot,
  allowedDirectories: [workspaceRoot],
} as WingmanConfig);

const createAuthContext = (npub: string | null): RequestAuthContext => ({
  npub,
  actorNpub: npub,
  session: null,
});

describe("resolveWorkspaceScope", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), `wingmen-workspace-${randomUUID()}-`));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  test("uses the configured workspace root for non-admin users", () => {
    const scope = resolveWorkspaceScope(
      createConfig(workspaceRoot),
      createAuthContext("npub1user"),
      "npub1admin",
      "/home/wingman",
      `/home/wingman${sep}`,
    );

    expect(scope.defaultDirectory).toBe(workspaceRoot);
    expect(scope.docsRoot).toBe(workspaceRoot);
    expect(scope.allowedDirectories).toEqual([workspaceRoot]);
    expect(scope.aliasDirectory).toBeNull();
    expect(scope.isAdmin).toBe(false);
  });

  test("keeps admin status without switching files to the home directory", () => {
    const scope = resolveWorkspaceScope(
      createConfig(workspaceRoot),
      createAuthContext("npub1admin"),
      "npub1admin",
      "/home/wingman",
      `/home/wingman${sep}`,
    );

    expect(scope.defaultDirectory).toBe(workspaceRoot);
    expect(scope.docsRoot).toBe(workspaceRoot);
    expect(scope.aliasDirectory).toBeNull();
    expect(scope.isAdmin).toBe(true);
  });

  test("recognizes any configured admin npub", () => {
    const scope = resolveWorkspaceScope(
      createConfig(workspaceRoot),
      createAuthContext("npub1secondadmin"),
      ["npub1admin", "npub1secondadmin"],
      "/home/wingman",
      `/home/wingman${sep}`,
    );

    expect(scope.isAdmin).toBe(true);
  });
});

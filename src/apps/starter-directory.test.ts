import { describe, expect, test } from "bun:test";

import { resolveStarterAppDirectory, resolveStarterAppParentDirectory } from "./starter-directory";
import type { WorkspaceScope } from "../workspaces/workspace-scope";

function scope(defaultDirectory: string): WorkspaceScope {
  return {
    defaultDirectory,
    allowedDirectories: [defaultDirectory],
    aliasDirectory: null,
    docsRoot: defaultDirectory,
    docsRootBoundary: `${defaultDirectory}/`,
    isAdmin: true,
  };
}

describe("starter app directory", () => {
  test("uses a code child when workspace root is the home directory", () => {
    expect(resolveStarterAppParentDirectory(scope("/Users/example"))).toBe("/Users/example/code");
    expect(resolveStarterAppDirectory(scope("/Users/example"), "testwapp")).toBe("/Users/example/code/testwapp");
  });

  test("does not add a nested code directory when workspace root is already code", () => {
    expect(resolveStarterAppParentDirectory(scope("/Users/example/code"))).toBe("/Users/example/code");
    expect(resolveStarterAppDirectory(scope("/Users/example/code"), "testwapp")).toBe("/Users/example/code/testwapp");
  });
});

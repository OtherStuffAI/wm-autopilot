import { basename, join, normalize } from "node:path";

import type { WorkspaceScope } from "../workspaces/workspace-scope";

export function resolveStarterAppParentDirectory(scope: WorkspaceScope): string {
  const workspaceRoot = normalize(scope.defaultDirectory);
  return basename(workspaceRoot) === "code" ? workspaceRoot : join(workspaceRoot, "code");
}

export function resolveStarterAppDirectory(scope: WorkspaceScope, directoryName: string): string {
  return normalize(join(resolveStarterAppParentDirectory(scope), directoryName));
}

import { expect, test } from "bun:test";
import { resolveAppAuthority, withAppAdminAccess } from "./app-admin";
import { deny } from "./access-control";
import { createApprovedAppOwnerRule, createTrustedExecutionRule } from "./trusted-execution";
import type { RequestAuthContext } from "./request-context";
import type { AppRecord } from "../apps/app-registry";
import type { WorkspaceScope } from "../workspaces/workspace-scope";

const scope = { isAdmin: true, defaultDirectory: "/tmp" } as WorkspaceScope;

test("app admin is the real principal, independent of two session owners and two unapproved app owners", () => {
  let admin = true;
  const isAdminNpub = (npub: string | null | undefined) => npub === "npub1bot" && admin;
  const trusted = createTrustedExecutionRule({ kind: "apps", isAdminNpub });
  const approved = createApprovedAppOwnerRule({ isAdminNpub, isApprovedNpub: () => false });
  const readAndLifecycle = withAppAdminAccess(() => deny("approval-required", 403), isAdminNpub);
  for (const sessionOwner of ["npub1session-a", "npub1session-b"]) {
    for (const owner of ["npub1owner-a", "npub1owner-b"]) {
      const auth: RequestAuthContext = { npub: "npub1bot", signerNpub: "npub1bot", subjectNpub: "npub1bot",
        advisoryOwnerNpub: sessionOwner, delegatedOwnerNpub: owner, targetOwnerNpub: owner, session: null };
      const original = structuredClone(auth);
      const authority = resolveAppAuthority({ auth, isAdminNpub, resolveWorkspace: () => scope });
      expect(authority.workspaceScope.isAdmin).toBe(true);
      expect(authority.canAccessApp({ ownerNpub: owner } as AppRecord)).toBe(true);
      expect(authority.canManageCore).toBe(true);
      const request = new Request("https://autopilot.example/api/apps/a/actions", { method: "POST" });
      const context = { auth, request, url: new URL(request.url) } as Parameters<typeof trusted>[0];
      for (const rule of [trusted, approved, readAndLifecycle]) expect(rule(context)).toEqual({ allowed: true });
      expect(auth).toEqual(original);
    }
  }
  admin = false;
  const auth: RequestAuthContext = { npub: "npub1bot", subjectNpub: "npub1bot", delegatedOwnerNpub: "npub1human-admin", session: null };
  const authority = resolveAppAuthority({ auth, isAdminNpub, resolveWorkspace: () => scope });
  expect(authority.workspaceScope.isAdmin).toBe(false);
  expect(authority.canManageCore).toBe(false);
  expect(authority.canAccessApp({ ownerNpub: "npub1foreign" } as AppRecord)).toBe(false);
});

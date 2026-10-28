import { expect, test } from "bun:test";
import { adminPrincipal, isInstanceAdmin } from "./admin-authority";
import { resolveOwnerAccess } from "./delegation-access";
import { createTrustedExecutionRule } from "./trusted-execution";
import { AccessActions } from "./access-control";
import type { RequestAuthContext } from "./request-context";

test("human and agent admins use their own live role independently of target or custodian", async () => {
  const admins = new Set(["npub1human", "npub1bot"]);
  const isAdmin = (npub: string | null | undefined) => Boolean(npub && admins.has(npub));
  const rule = createTrustedExecutionRule({ kind: "sessions", isAdminNpub: isAdmin });
  for (const principal of ["npub1human", "npub1bot"]) {
    const auth: RequestAuthContext = { npub: "npub1target", subjectNpub: principal, signerNpub: principal,
      actorNpub: principal, targetOwnerNpub: "npub1target", advisoryOwnerNpub: "npub1custodian", session: null };
    expect(adminPrincipal(auth)).toBe(principal);
    expect(isInstanceAdmin(auth, isAdmin)).toBe(true);
    expect(resolveOwnerAccess(auth, "npub1target", () => null, "sessions:manage", isAdmin)?.delegation).toBeNull();
    const url = new URL("https://example/api/owners/npub1target/sessions");
    const request = new Request(url, { method: "POST" });
    expect((await rule({ action: AccessActions.SessionsManage, request, url, auth }))?.allowed).toBe(true);
    admins.delete(principal);
    expect(isInstanceAdmin(auth, isAdmin)).toBe(false);
    expect(resolveOwnerAccess(auth, "npub1target", () => null, "sessions:manage", isAdmin)).toBeNull();
    expect((await rule({ action: AccessActions.SessionsManage, request, url, auth }))?.allowed).toBe(false);
  }
  const nonadmin = { npub: "npub1admin", subjectNpub: "npub1nonadmin", signerNpub: "npub1nonadmin", session: null };
  expect(isInstanceAdmin(nonadmin, npub => npub === "npub1admin")).toBe(false);
});

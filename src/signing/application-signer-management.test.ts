import { expect, test } from "bun:test";
import { handleSigningPolicyApi } from "../server/signing-policy-routes";
import type { SigningPolicyRoutesContext } from "../server/signing-policy-routes";
import type { RequestAuthContext } from "../auth/request-context";
import type { ApplicationSigner } from "./application-signer";
import { handleApplicationSignerManagement } from "./application-signer-management";
import { BROKER_KEY_NOT_PROVISIONED } from "./broker-key-vault";

test("application registration goes through management authorization before touching custody", async () => {
  let calls = 0;
  const ctx = { applicationSigner: { registerVerified: () => { calls++; throw new Error("must not reach"); } } as unknown as ApplicationSigner,
    ensureApiAccess: async () => Response.json({ error: "denied" }, { status: 403 }),
    AccessActions: { SystemManage: "system:manage" } } as unknown as SigningPolicyRoutesContext;
  const url = new URL("http://localhost/api/admin/signing-policies/applications");
  const response = await handleSigningPolicyApi(new Request(url, { method: "POST", body: "{}" }), url, "POST", { npub: "actor" } as RequestAuthContext, ctx);
  expect(response?.status).toBe(403); expect(calls).toBe(0);
});

test("registration surfaces unavailable custody without leaking upstream details", async () => {
  const signer = { registerVerified: async () => { throw Object.assign(new Error("private upstream detail"), { code: BROKER_KEY_NOT_PROVISIONED }); } } as unknown as ApplicationSigner;
  const url = new URL("http://localhost/api/admin/signing-policies/applications");
  const response = await handleApplicationSignerManagement(new Request(url, { method: "POST", body: "{}" }), url, "actor", signer);
  expect(await response?.json()).toEqual({ error: BROKER_KEY_NOT_PROVISIONED });
});

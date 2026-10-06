import { expect, test } from "bun:test";
import { handleSigningPolicyApi } from "../server/signing-policy-routes";
import type { SigningPolicyRoutesContext } from "../server/signing-policy-routes";
import type { RequestAuthContext } from "../auth/request-context";
import { ApplicationSigner } from "./application-signer";
import { handleApplicationSignerManagement } from "./application-signer-management";
import { BROKER_KEY_NOT_PROVISIONED } from "./broker-key-vault";
import { BrokerKeyVault } from "./broker-key-vault";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import type { BotKeyRecord } from "../identity/bot-key-store";

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

test("management grant needs both administrator access and the effective bot owner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grant-management-"));
  const key = generateSecretKey();
  const record = { id: "fixture", botNpub: "bot", userNpub: "owner", botPubkeyHex: getPublicKey(key) } as BotKeyRecord;
  const vault = new BrokerKeyVault({ dataDir: dir });
  vault.provision(record, key); key.fill(0);
  const signer = new ApplicationSigner(join(dir, "grants.db"), () => record, vault);
  try {
    const url = new URL("http://localhost/api/admin/signing-policies/applications");
    const invoke = async (auth: Partial<RequestAuthContext>, adminAllowed: boolean) => {
      const ctx = { applicationSigner: signer,
        ensureApiAccess: async () => adminAllowed ? null : Response.json({ error: "admin-only" }, { status: 403 }),
        AccessActions: { SystemManage: "system:manage" } } as unknown as SigningPolicyRoutesContext;
      return await handleSigningPolicyApi(new Request(url, { method: "POST", body: JSON.stringify({
        botNpub: "bot", expectedPubkey: record.botPubkeyHex,
        policy: { methods: ["get_public_key"], kindRules: [], peers: [] },
      }) }), url, "POST", auth as RequestAuthContext, ctx);
    };
    expect((await invoke({ npub: "owner" }, false))?.status).toBe(403);
    expect(await (await invoke({ npub: "unrelated-admin" }, true))?.json()).toEqual({ error: "identity_denied" });
    expect(await (await invoke({ npub: "bot", delegatedOwnerNpub: "owner", advisoryOwnerNpub: "owner" }, true))?.json()).toEqual({ error: "identity_denied" });
    const registered = await invoke({ npub: "owner" }, true);
    expect(registered?.status).toBe(201);
    expect(registered?.headers.get("cache-control")).toBe("no-store");
    const body = await registered!.json();
    expect(body.grant.ownerNpub).toBe("owner");
    expect(await signer.execute({ id: "verified", credential: body.credential, method: "get_public_key", params: {} })).toBe(record.botPubkeyHex);
  } finally { signer.close(); vault.destroy(); rmSync(dir, { recursive: true, force: true }); }
});

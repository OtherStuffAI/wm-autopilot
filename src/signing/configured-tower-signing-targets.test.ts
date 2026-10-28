import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey, nip19, verifyEvent } from "nostr-tools";
import { BackendConnectionStore } from "../agent-chat/backend-connection-store";
import { Nip98ReplayCache, verifyNip98Request } from "../auth/nip98-verifier";
import { CapabilityBroker, buildDefaultAgentCapabilityPolicy, type SessionCapabilityPolicy } from "./capability-broker";
import { createLiveAdminSigningTargets } from "./configured-tower-signing-targets";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tower-discovery-signing-"));
  roots.push(root);
  const store = new BackendConnectionStore(join(root, "connections.db"));
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  const botNpub = nip19.npubEncode(pubkey);
  const owner = nip19.npubEncode(getPublicKey(generateSecretKey()));
  const record = { userNpub: owner, botNpub, botPubkeyHex: pubkey };
  const session = { id: "session", npub: owner, status: "running" };
  let admin = false;
  let now = Date.now();
  const connection = store.save(store.createDefault({ managedByNpub: owner,
    backendBaseUrl: "https://tower.example", serviceNpub: botNpub }));
  const resolver = createLiveAdminSigningTargets({ autopilotUrl: "https://autopilot.example",
    isAdminNpub: npub => admin && npub === botNpub,
    listAvailableConnections: npub => store.listAvailableForManagerNpub(npub) });
  const broker = new CapabilityBroker({
    liveNip98Targets: resolver,
    getSession: () => session as never,
    botKeyStore: { getActiveKeyForUser: () => record, getActiveKeyForBotNpub: () => record } as never,
    keyVault: { withKey: async (_record, operation) => operation(new Uint8Array(secret)) },
    now: () => now,
  });
  const baseline = buildDefaultAgentCapabilityPolicy({ towerUrl: "http://127.0.0.1:3100",
    autopilotUrl: "https://autopilot.example", ownerNpub: owner });
  const issue = (policy = baseline) => broker.issueSessionCapability({ sessionId: session.id, ownerNpub: owner, policy });
  const call = async (token: string, body: Record<string, unknown>, suffix = "nip98") => {
    const url = new URL(`http://localhost/api/mcp/capabilities/${suffix}`);
    return (await broker.handle(new Request(url, { method: "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json", "x-wingman-capability-nonce": crypto.randomUUID(),
    }, body: JSON.stringify({ sessionId: session.id, ...body }) }), url, "POST"))!;
  };
  const share = (shared: boolean, managers: string[] = []) => store.replaceAvailabilityGrants({
    backendConnectionId: connection.backendConnectionId, sharedService: shared, managerNpubs: managers,
  });
  return { store, connection, broker, botNpub, pubkey, owner, session, baseline, issue, call, share,
    promote: (value: boolean) => { admin = value; }, advance: () => { now += 3_600_000; },
    now: () => Math.floor(now / 1000) };
}

test("Admin discovers only connections available to its actual signer, live across grants and refresh", async () => {
  const f = fixture();
  const { token } = f.issue();
  const target = "https://tower.example/api/v4/flightdeck-pg/workspaces?limit=20";
  const sign = () => f.call(token, { url: target, method: "GET" });
  expect((await sign()).status).toBe(403);
  f.promote(true);
  // A private custodian-owned connection confers no signer authority.
  expect((await sign()).status).toBe(403);
  f.share(true);
  const response = await sign();
  expect(response.status).toBe(200);
  const proof = (await response.json()).token;
  const event = JSON.parse(Buffer.from(proof.slice(6), "base64").toString());
  expect(verifyEvent(event)).toBe(true);
  expect(event.pubkey).toBe(f.pubkey);
  expect(event.tags).toContainEqual(["u", target]);
  expect(event.tags).toContainEqual(["method", "GET"]);
  const replayCache = new Nip98ReplayCache();
  const verify = (url: string, method = "GET") => verifyNip98Request({
    request: new Request(url, { method, headers: { authorization: proof } }), requestUrl: new URL(url),
    configuredBaseUrl: "https://tower.example", replayCache, now: f.now(),
  });
  expect(await verify(target + "0")).toBeNull();
  expect(await verify(target, "DELETE")).toBeNull();
  expect((await verify(target))?.signerNpub).toBe(f.botNpub);
  expect(await verify(target)).toBeNull();
  f.advance();
  expect((await f.call(token, {}, "refresh")).status).toBe(200);
  expect((await sign()).status).toBe(200);
  f.share(false);
  expect((await sign()).status).toBe(403);
  expect((await f.call(token, {}, "refresh")).status).toBe(200);
  expect((await sign()).status).toBe(403);
  f.share(false, [f.botNpub]);
  expect((await sign()).status).toBe(200);
  f.share(false, [f.owner]);
  expect((await sign()).status).toBe(403);
  f.share(true);
  f.promote(false);
  expect((await sign()).status).toBe(403);
  f.promote(true);
  expect((await sign()).status).toBe(200);
  f.broker.revokeSession(f.session.id);
  expect((await sign()).status).toBe(403);
  expect((await f.call(token, {}, "refresh")).status).toBe(403);
});

test("discovery is exact read-only PG paths, with no WApp URL or unrelated origin authority", async () => {
  const f = fixture();
  f.promote(true);
  f.share(true);
  const { token } = f.issue();
  for (const path of ["service", "workspaces", "workspaces/workspace-a/descriptor", "workspaces/workspace-a/me", "workspaces/workspace-a/scopes"]) {
    expect((await f.call(token, { url: `https://tower.example/api/v4/flightdeck-pg/${path}`, method: "GET" })).status).toBe(200);
  }
  for (const url of [
    "https://unconfigured.example/api/v4/flightdeck-pg/workspaces",
    "https://tower.example.evil/api/v4/flightdeck-pg/workspaces",
    "https://tower.example:444/api/v4/flightdeck-pg/workspaces",
    "https://tower.example/api/admin/users",
    "https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-a/tasks",
    "https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-a/scopes/extra",
    "https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-a%2fother/scopes",
    "https://tower.example/api/v4/flightdeck-pg/workspaces-other",
  ]) expect((await f.call(token, { url, method: "GET" })).status).toBe(403);
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
    expect((await f.call(token, { url: "https://tower.example/api/v4/flightdeck-pg/workspaces", method,
      bodyHash: "ab".repeat(32) })).status).toBe(403);
  }
});

test("selected transport and base path are exact; obsolete aliases are not discovery grants", async () => {
  const f = fixture();
  f.promote(true);
  f.share(true);
  const { token } = f.issue();
  const sign = (url: string) => f.call(token, { url, method: "GET" });
  const mesh = `http://${f.botNpub}.fips:43100`;
  f.store.save({ ...f.connection, sharePolicy: "shared_service", transport: { mode: "fips",
    httpsEndpoint: "https://tower.example", fipsEndpoint: mesh, expectedServiceNpub: f.botNpub } });
  expect((await sign("https://tower.example/api/v4/flightdeck-pg/workspaces")).status).toBe(403);
  expect((await sign(`${mesh}/api/v4/flightdeck-pg/workspaces`)).status).toBe(200);
  f.store.save({ ...f.connection, sharePolicy: "shared_service", transport: { mode: "https",
    httpsEndpoint: "https://alternate.example/tower/", fipsEndpoint: mesh, expectedServiceNpub: f.botNpub } });
  expect((await sign(`${mesh}/api/v4/flightdeck-pg/workspaces`)).status).toBe(403);
  expect((await sign("https://tower.example/api/v4/flightdeck-pg/workspaces")).status).toBe(403);
  expect((await sign("https://alternate.example/api/v4/flightdeck-pg/workspaces")).status).toBe(403);
  expect((await sign("https://alternate.example/tower/api/v4/flightdeck-pg/workspaces")).status).toBe(200);
});

test("none, custom, removed-operation and body-constrained policies remain unchanged", async () => {
  const f = fixture();
  f.promote(true);
  f.share(true);
  const policies: SessionCapabilityPolicy[] = [
    { ...f.baseline, mode: "none" },
    { ...f.baseline, mode: undefined },
    { ...f.baseline, operations: ["identity.read", "capability.refresh"] },
    { ...f.baseline, nip98: { ...f.baseline.nip98!, bodyHashes: ["ab".repeat(32)] } },
    { ...f.baseline, nip98: { ...f.baseline.nip98!, targets: [] } },
    { ...f.baseline, nip98: { ...f.baseline.nip98!, targets: [...f.baseline.nip98!.targets!, {
      origin: "https://tower.example", methods: ["POST"], pathPrefixes: ["/api/v4/flightdeck-pg"],
      requireBodyHashMethods: ["POST"],
    }] } },
  ];
  for (const policy of policies) {
    const { token } = f.issue(policy);
    expect((await f.call(token, { url: "https://tower.example/api/v4/flightdeck-pg/workspaces", method: "GET" })).status).toBe(403);
  }
  const exact = f.issue({ ...f.baseline, nip98: { ...f.baseline.nip98!, targets: [...f.baseline.nip98!.targets!, {
    origin: "https://tower.example", methods: ["GET"], pathPrefixes: [],
    exactPaths: [{ path: "/api/v4/flightdeck-pg/workspaces", methods: ["GET"], requireBodyHash: true }],
  }] } });
  const url = "https://tower.example/api/v4/flightdeck-pg/workspaces";
  expect((await f.call(exact.token, { url, method: "GET" })).status).toBe(400);
  expect((await f.call(exact.token, { url, method: "GET", bodyHash: "ab".repeat(32) })).status).toBe(200);
  const fullNostr = f.issue({ ...f.baseline, mode: "full-nostr" });
  expect((await f.call(fullNostr.token, { url: "https://tower.example/api/v4/flightdeck-pg/workspaces", method: "GET" })).status).toBe(200);
});

test("existing workspace request signing keeps exact URL, method and body verification", async () => {
  const f = fixture();
  const policy = buildDefaultAgentCapabilityPolicy({ towerUrl: "https://tower.example",
    autopilotUrl: "https://autopilot.example", ownerNpub: f.owner, workspaceId: "workspace-a" });
  const { token } = f.issue(policy);
  const url = "https://tower.example/api/v4/flightdeck-pg/workspaces/workspace-a/tasks?mode=exact";
  const body = JSON.stringify({ title: "Fixture only" });
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const response = await f.call(token, { url, method: "POST", bodyHash });
  expect(response.status).toBe(200);
  const proof = (await response.json()).token;
  const verify = (target: string, method: string, bytes: string) => verifyNip98Request({
    request: new Request(target, { method, body: bytes, headers: { authorization: proof } }),
    requestUrl: new URL(target), configuredBaseUrl: "https://tower.example", replayCache: new Nip98ReplayCache(), now: f.now(),
  });
  expect((await verify(url, "POST", body))?.signerNpub).toBe(f.botNpub);
  expect(await verify(url + "0", "POST", body)).toBeNull();
  expect(await verify(url, "PUT", body)).toBeNull();
  expect(await verify(url, "POST", body + " ")).toBeNull();
  expect((await f.call(token, { url: url.replace("workspace-a", "workspace-b"), method: "POST", bodyHash })).status).toBe(403);
});

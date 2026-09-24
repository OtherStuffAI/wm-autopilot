import { describe, expect, test } from "bun:test";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import type { WingmanInstanceIdentity } from "../identity/wingman-instance-identity";
import {
  CONNECT_PACKAGE_EVENT_KIND,
  canonicalConnectManifest,
  createAutopilotConnectPackage,
  createAutopilotConnectPackageV2,
  verifyAutopilotConnectPackage,
} from "./connect-package";

function identity(): WingmanInstanceIdentity {
  const secretKey = generateSecretKey();
  const pubkeyHex = getPublicKey(secretKey);
  return {
    secretKey,
    pubkeyHex,
    npub: nip19.npubEncode(pubkeyHex),
    nsec: nip19.nsecEncode(secretKey),
    nsecHex: Buffer.from(secretKey).toString("hex"),
    displayName: "Generic Autopilot",
    source: "generated",
  };
}

function createFixture(now = new Date("2026-09-24T02:00:00.250Z")) {
  const signingIdentity = identity();
  const ownerNpub = nip19.npubEncode(getPublicKey(generateSecretKey()));
  return {
    signingIdentity,
    ownerNpub,
    now,
    package: createAutopilotConnectPackage({
      identity: signingIdentity,
      fipsEndpoint: `http://${signingIdentity.npub}.fips:3601/`,
      ownerNpub,
      httpsEndpoint: "https://autopilot.example/base",
      now,
    }),
  };
}

describe("Autopilot connect package", () => {
  test("matches the Flight Deck build 2050 envelope, manifest, canonical signature, and advertised owner paths", () => {
    const fixture = createFixture();
    const created = fixture.package;
    expect(Object.keys(created)).toEqual(["manifest", "signature"]);
    expect(created.manifest).toEqual({
      kind: "wingman_autopilot_connect",
      version: 1,
      generated_at: fixture.now.toISOString(),
      installation: {
        id: expect.stringMatching(/^autopilot_[0-9a-f]{32}$/),
        npub: fixture.signingIdentity.npub,
      },
      endpoints: {
        fips: `http://${fixture.signingIdentity.npub}.fips:3601`,
        https: "https://autopilot.example",
      },
      api: {
        version: 1,
        capabilities: [
          "health",
          "agents.read",
          "agents.overview.read",
          "agents.pipelines.read",
          "agents.schedules.read",
          "agents.triggers.read",
        ],
        health_path: `/api/owners/${fixture.ownerNpub}/control-plane/v1/health`,
        agents_path: `/api/owners/${fixture.ownerNpub}/control-plane/v1/agents`,
      },
    });
    expect(created.signature.kind).toBe(CONNECT_PACKAGE_EVENT_KIND);
    expect(created.signature.kind).toBe(27236);
    expect(created.signature.content).toBe(canonicalConnectManifest(created.manifest));
    expect(verifyAutopilotConnectPackage(created, { now: fixture.now })).toEqual(created);
  });

  test("rejects tampering, unsupported versions, signer/FIPS mismatches, and expired packages", () => {
    const fixture = createFixture();
    expect(() => verifyAutopilotConnectPackage({
      ...fixture.package,
      manifest: { ...fixture.package.manifest, generated_at: "2026-09-24T02:00:01.250Z" },
    }, { now: fixture.now })).toThrow("tampered");
    expect(() => verifyAutopilotConnectPackage({
      ...fixture.package,
      manifest: { ...fixture.package.manifest, version: 3 },
    }, { now: fixture.now })).toThrow("version");
    expect(() => verifyAutopilotConnectPackage(fixture.package, {
      now: new Date(fixture.now.getTime() + 301_000),
    })).toThrow("expired");

    const other = identity();
    const wrongSigner = {
      manifest: fixture.package.manifest,
      signature: finalizeEvent({
        kind: 27236,
        created_at: Math.floor(fixture.now.getTime() / 1000),
        tags: [],
        content: canonicalConnectManifest(fixture.package.manifest),
      }, other.secretKey),
    };
    expect(() => verifyAutopilotConnectPackage(wrongSigner, { now: fixture.now })).toThrow("signer");
    expect(() => createAutopilotConnectPackage({
      identity: fixture.signingIdentity,
      fipsEndpoint: `http://${other.npub}.fips:3601`,
      ownerNpub: fixture.ownerNpub,
      now: fixture.now,
    })).toThrow("match its signed transport identity");
  });

  test("binds a distinct FIPS transport identity in a v2 manifest signed by the stable installation", () => {
    const fixture = createFixture();
    const transport = identity();
    const created = createAutopilotConnectPackageV2({
      identity: fixture.signingIdentity,
      fipsEndpoint: `http://${transport.npub}.fips:3601/`,
      fipsNodeNpub: transport.npub,
      ownerNpub: fixture.ownerNpub,
      httpsEndpoint: "https://autopilot.example/base",
      now: fixture.now,
    });
    expect(created.manifest).toMatchObject({
      version: 2,
      installation: { npub: fixture.signingIdentity.npub },
      transport: { fips: { npub: transport.npub } },
      endpoints: { fips: `http://${transport.npub}.fips:3601` },
      api: { version: 1 },
    });
    expect(created.signature.pubkey).toBe(fixture.signingIdentity.pubkeyHex);
    expect(verifyAutopilotConnectPackage(created, { now: fixture.now })).toEqual(created);

    const otherTransport = identity();
    expect(() => createAutopilotConnectPackageV2({
      identity: fixture.signingIdentity,
      fipsEndpoint: `http://${otherTransport.npub}.fips:3601`,
      fipsNodeNpub: transport.npub,
      ownerNpub: fixture.ownerNpub,
      now: fixture.now,
    })).toThrow("match its signed transport identity");

    const tampered = structuredClone(created);
    tampered.manifest.transport.fips.npub = otherTransport.npub;
    expect(() => verifyAutopilotConnectPackage(tampered, { now: fixture.now })).toThrow("tampered");

    const inconsistentManifest = {
      ...created.manifest,
      endpoints: { ...created.manifest.endpoints, fips: `http://${otherTransport.npub}.fips:3601` },
    };
    const inconsistent = {
      manifest: inconsistentManifest,
      signature: finalizeEvent({
        kind: CONNECT_PACKAGE_EVENT_KIND,
        created_at: Math.floor(fixture.now.getTime() / 1000),
        tags: [["d", created.manifest.installation.id]],
        content: canonicalConnectManifest(inconsistentManifest),
      }, fixture.signingIdentity.secretKey),
    };
    expect(() => verifyAutopilotConnectPackage(inconsistent, { now: fixture.now })).toThrow("transport identity");
  });

  test("rejects secret-bearing packages and exports no reusable credential", () => {
    const fixture = createFixture();
    const encoded = JSON.stringify(fixture.package);
    expect(encoded).not.toContain(fixture.signingIdentity.nsec);
    expect(encoded).not.toContain(fixture.signingIdentity.nsecHex);
    expect(encoded).not.toMatch(/bunker:\/\/|bearer|nwc|private.?key|secret/i);
    expect(() => verifyAutopilotConnectPackage({
      ...fixture.package,
      credentials: { private_key: "nsec1forbidden" },
    }, { now: fixture.now })).toThrow("forbidden credential");
  });
});

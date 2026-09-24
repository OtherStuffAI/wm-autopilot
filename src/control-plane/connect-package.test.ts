import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import type { WingmanInstanceIdentity } from "../identity/wingman-instance-identity";
import {
  canonicalConnectPackagePayload,
  createAutopilotConnectPackage,
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

describe("Autopilot connect package", () => {
  test("signs every public field with deterministic canonical serialization", () => {
    const now = new Date("2026-09-24T02:00:00.250Z");
    const created = createAutopilotConnectPackage({
      identity: identity(),
      fipsEndpoint: "http://npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq.fips:3601/",
      httpsEndpoint: "https://autopilot.example/",
      now,
    });
    expect(verifyAutopilotConnectPackage(created, { now })).toEqual(created);
    expect(created.signedEvent.content).toBe(canonicalConnectPackagePayload(created.payload));
  });

  test("rejects tampering, unsupported versions, and expired generation times", () => {
    const createdAt = new Date("2026-09-24T02:00:00Z");
    const created = createAutopilotConnectPackage({ identity: identity(), fipsEndpoint: "http://example.fips:3601/", now: createdAt });
    expect(() => verifyAutopilotConnectPackage({ ...created, payload: { ...created.payload, fipsEndpoint: "https://attacker.example/" } }, { now: createdAt })).toThrow("tampered");
    expect(() => verifyAutopilotConnectPackage({ ...created, payload: { ...created.payload, version: 2 } }, { now: createdAt })).toThrow("version");
    expect(() => verifyAutopilotConnectPackage(created, { now: new Date(createdAt.getTime() + 301_000) })).toThrow("expired");
  });

  test("exports no reusable secret or credential", () => {
    const signingIdentity = identity();
    const created = createAutopilotConnectPackage({ identity: signingIdentity, fipsEndpoint: "http://example.fips:3601/" });
    const encoded = JSON.stringify(created);
    expect(encoded).not.toContain(signingIdentity.nsec);
    expect(encoded).not.toContain(signingIdentity.nsecHex);
    expect(encoded).not.toMatch(/bunker:\/\/|bearer|nwc|private.?key|secret/i);
  });
});

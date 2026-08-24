import { describe, expect, test } from "bun:test";

import { resolveSessionCapabilityBotRecord } from "./session-capability-identity";

const ownerNpub = "npub1owner";
const records = new Map([
  ["npub1alpha", { botNpub: "npub1alpha", userNpub: ownerNpub }],
  ["npub1beta", { botNpub: "npub1beta", userNpub: ownerNpub }],
]);
const profiles = [
  { botNpub: "npub1alpha", workingDirectory: "/wingmen/alpha", enabled: true },
  { botNpub: "npub1beta", workingDirectory: "/wingmen/beta", enabled: true },
];

describe("session capability identity resolution", () => {
  test("replaces a retired requested identity with the unique active profile for the session directory", () => {
    expect(resolveSessionCapabilityBotRecord({
      ownerNpub,
      requestedBotNpub: "npub1retired",
      workingDirectory: "/wingmen/beta",
      profiles,
      getActiveByBotNpub: (botNpub) => records.get(botNpub) ?? null,
      getActiveForOwner: () => records.get("npub1alpha")!,
    })?.botNpub).toBe("npub1beta");
  });

  test("preserves an explicitly requested active identity", () => {
    expect(resolveSessionCapabilityBotRecord({
      ownerNpub,
      requestedBotNpub: "npub1alpha",
      workingDirectory: "/wingmen/beta",
      profiles,
      getActiveByBotNpub: (botNpub) => records.get(botNpub) ?? null,
      getActiveForOwner: () => records.get("npub1beta")!,
    })?.botNpub).toBe("npub1alpha");
  });

  test("fails closed for a retired identity when the directory does not identify one profile", () => {
    expect(resolveSessionCapabilityBotRecord({
      ownerNpub,
      requestedBotNpub: "npub1retired",
      workingDirectory: "/wingmen/shared",
      profiles,
      getActiveByBotNpub: (botNpub) => records.get(botNpub) ?? null,
      getActiveForOwner: () => records.get("npub1alpha")!,
    })).toBeNull();
  });
});

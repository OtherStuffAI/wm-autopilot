import { describe, expect, test } from "bun:test";

import { resolveSessionCapabilityBotRecord } from "./session-capability-identity";

const ownerNpub = "npub1owner";
const records = new Map([
  ["npub1alpha", { botNpub: "npub1alpha", userNpub: ownerNpub }],
  ["npub1beta", { botNpub: "npub1beta", userNpub: ownerNpub }],
]);
const profiles = [
  { profileId: "alpha", botNpub: "npub1alpha", enabled: true },
  { profileId: "beta", botNpub: "npub1beta", enabled: true },
];

describe("session capability identity resolution", () => {
  test("replaces a retired requested identity from its explicit profile binding", () => {
    expect(resolveSessionCapabilityBotRecord({
      ownerNpub,
      requestedProfileId: "beta",
      requestedBotNpub: "npub1retired",
      profiles,
      defaultProfile: profiles[0],
      getActiveByBotNpub: (botNpub) => records.get(botNpub) ?? null,
    })?.record.botNpub).toBe("npub1beta");
  });

  test("preserves an explicitly requested active identity", () => {
    expect(resolveSessionCapabilityBotRecord({
      ownerNpub,
      requestedProfileId: "alpha",
      requestedBotNpub: "npub1alpha",
      profiles,
      defaultProfile: profiles[1],
      getActiveByBotNpub: (botNpub) => records.get(botNpub) ?? null,
    })?.record.botNpub).toBe("npub1alpha");
  });

  test("uses the configured default profile for an ordinary Autopilot session", () => {
    expect(resolveSessionCapabilityBotRecord({
      ownerNpub,
      profiles,
      defaultProfile: profiles[0],
      getActiveByBotNpub: (botNpub) => records.get(botNpub) ?? null,
    })).toMatchObject({ record: { botNpub: "npub1alpha" }, profileId: "alpha" });
  });

  test("fails closed for a retired identity without an explicit profile", () => {
    expect(resolveSessionCapabilityBotRecord({
      ownerNpub,
      requestedBotNpub: "npub1retired",
      profiles,
      defaultProfile: profiles[0],
      getActiveByBotNpub: (botNpub) => records.get(botNpub) ?? null,
    })).toBeNull();
  });

  test("does not infer identity from a session working directory", () => {
    expect(resolveSessionCapabilityBotRecord({
      ownerNpub,
      profiles,
      defaultProfile: profiles[0],
      getActiveByBotNpub: (botNpub) => records.get(botNpub) ?? null,
    })?.profileId).toBe("alpha");
  });
});

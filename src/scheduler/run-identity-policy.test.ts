import { expect, test } from "bun:test";
import { createSchedulerRunIdentityPolicy } from "./run-identity-policy";
import type { BotKeyRecord } from "../identity/bot-key-store";

function fixture() {
  const profiles = ["instance", "registered", "revoked", "foreign", "unprovisioned", "disabled", "archived"]
    .map(botNpub => ({ agentId: `profile-${botNpub}`, botNpub, label: botNpub,
      enabled: botNpub !== "disabled", archived: botNpub === "archived" }));
  const keys = new Map(["registered", "foreign", "unprovisioned"].map(botNpub =>
    [botNpub, { botNpub, userNpub: botNpub === "foreign" ? "other" : "owner" } as BotKeyRecord]));
  let instance: string | null = "instance";
  const policy = createSchedulerRunIdentityPolicy({
    keys: { getActiveKeyForBotNpub: bot => keys.get(bot) ?? null },
    getInstanceNpub: () => instance,
    listProfiles: owner => owner === "owner" ? profiles : [],
    isKeyAvailable: key => key.botNpub !== "unprovisioned",
  });
  return { profiles, keys, policy, setInstance: (value: string | null) => { instance = value; } };
}

test("listing and validation recognize exact instance profile without registering or substituting keys", () => {
  const f = fixture();
  expect(f.policy.list("owner")).toEqual([
    { botNpub: "instance", name: "instance" }, { botNpub: "registered", name: "registered" },
  ]);
  expect(f.policy.resolve({ userNpub: "owner", botNpub: "instance" }).agentId).toBe("profile-instance");
  expect(f.keys.has("instance")).toBe(false);
  expect(f.policy.list("other")).toEqual([]);
  expect(() => f.policy.validate({ userNpub: "other", botNpub: "instance" })).toThrow("active profile");
  for (const botNpub of ["", "unknown", "revoked", "foreign", "unprovisioned", "disabled", "archived"]) {
    expect(() => f.policy.validate({ userNpub: "owner", botNpub })).toThrow();
  }
});

test("revalidates live profile, registration, provisioning and instance configuration", () => {
  const f = fixture();
  f.keys.delete("registered");
  expect(() => f.policy.validate({ userNpub: "owner", botNpub: "registered" })).toThrow("unknown, revoked");
  f.profiles[0]!.enabled = false;
  expect(() => f.policy.validate({ userNpub: "owner", botNpub: "instance" })).toThrow("active profile");
  f.profiles[0]!.enabled = true;
  f.setInstance("replacement");
  expect(() => f.policy.validate({ userNpub: "owner", botNpub: "instance" })).toThrow("unknown, revoked");
  f.setInstance(null);
  expect(f.policy.list("owner")).toEqual([]);
  expect(() => f.policy.validate({ userNpub: "owner", botNpub: "instance" })).toThrow("WINGMAN_PRIV");
});

test("configured instance never overrides an existing registered owner binding", () => {
  const f = fixture();
  f.keys.set("instance", { botNpub: "instance", userNpub: "other" } as BotKeyRecord);
  expect(() => f.policy.validate({ userNpub: "owner", botNpub: "instance" })).toThrow("not owned");
  expect(f.policy.list("owner")).toEqual([{ botNpub: "registered", name: "registered" }]);
});

test("listing surfaces infrastructure failures instead of hiding them as missing identities", () => {
  const policy = createSchedulerRunIdentityPolicy({
    keys: { getActiveKeyForBotNpub: () => { throw new Error("database unavailable"); } },
    getInstanceNpub: () => "instance", isKeyAvailable: () => true,
    listProfiles: () => [{ agentId: "profile", botNpub: "instance", label: "Agent", enabled: true }],
  });
  expect(() => policy.list("owner")).toThrow("database unavailable");
});

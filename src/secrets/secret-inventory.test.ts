import { expect, test } from "bun:test";
import { getPublicKey, nip19 } from "nostr-tools";
import { createSecretInventory } from "./secret-inventory";

const owner = nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(1)));
const bot = nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(2)));
test("inventory exposes owner-managed workspaces and authoritative identity labels", async () => {
  const inventory = await createSecretInventory({
    workspaces: () => [
      { workspaceId: "owned", workspaceOwnerNpub: owner, lifecycleStatus: "active" },
      { workspaceId: "foreign", workspaceOwnerNpub: bot, lifecycleStatus: "active" },
      { workspaceId: "retired", workspaceOwnerNpub: owner, lifecycleStatus: "inactive" },
    ],
    users: () => [{ npub: owner, profileName: "Owner profile" }],
    bots: () => [{ botNpub: bot, displayName: "Authorized bot" }],
    pipelines: async requestedOwner => { expect(requestedOwner).toBe(owner); return [{ id: "stable-id", name: "Pipeline" }]; },
    apps: async () => [{ id: "owned-app", label: "Owned", root: "/owned", ownerNpub: owner }, { id: "foreign-app", label: "Foreign", root: "/foreign", ownerNpub: bot }],
  })(owner);
  expect(inventory.workspaces.map(row => row.id)).toEqual(["local", "owned"]);
  expect(inventory.identities).toEqual([{ npub: owner, label: "Owner profile", type: "user" }, { npub: bot, label: "Authorized bot", type: "bot" }]);
  expect(inventory.pipelines).toEqual([{ id: "stable-id", label: "Pipeline" }]);
  expect(inventory.apps).toEqual([{ id: "owned-app", label: "Owned", root: "/owned" }]);
});

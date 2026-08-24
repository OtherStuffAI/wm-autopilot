import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import { InstallationIntentConsumer } from "./installation-intent-consumer";

const app = { id: "book", label: "Book of Sand", ownerNpub: "npub1owner", updatedAt: "version-1", webApp: true, webAppPort: 41024 } as any;
const baseIntent = {
  id: "intent", workspace_id: "workspace", status: "pending", intent_version: 1, owner_npub: "npub1owner",
  request: { app_id: "book", app_version: "version-1", wapp_installation_id: "installation", title: "Book of Sand", description: null, launch_url: "https://book.example", autopilot_origin: "https://autopilot.example", autopilot_npub: "npub1autopilot", registered_open_origins: ["https://book.example"], capabilities: ["activity.publish"], scope_id: "scope", destinations: [{ scope_id: "scope", channel_id: "feed" }] },
};

function consumer(intent = baseIntent, selectedApp = app) {
  const secret = generateSecretKey();
  const npub = nip19.npubEncode(getPublicKey(secret));
  const normalizedIntent = intent.request.autopilot_npub === "npub1autopilot" ? { ...intent, request: { ...intent.request, autopilot_npub: npub } } : intent;
  const fetchImpl = async () => Response.json({ intent: normalizedIntent });
  return new InstallationIntentConsumer({
    towerUrl: "https://tower.example", autopilotOrigin: "https://autopilot.example",
    identity: { botNpub: npub, botPubkeyHex: getPublicKey(secret), botSecret: secret },
    appRegistry: { listApps: async () => [selectedApp], getApp: async () => selectedApp },
    appAliasRegistry: { getByAppId: async () => ({ alias: "book" }) },
    wappStore: {} as any, buildLaunchUrl: () => "https://book.example", fetchImpl: fetchImpl as any,
  });
}

describe("Tower installation intent consumer", () => {
  test("rejects the wrong Autopilot identity and origin", async () => {
    await expect(consumer({ ...baseIntent, request: { ...baseIntent.request, autopilot_npub: "npub1other" } } as any).process("workspace", "intent")).rejects.toMatchObject({ code: "wrong_autopilot_identity" });
    await expect(consumer({ ...baseIntent, request: { ...baseIntent.request, autopilot_origin: "https://other.example" } } as any).process("workspace", "intent")).rejects.toMatchObject({ code: "wrong_autopilot_origin" });
  });

  test("rejects capability, View-origin, and immutable-version expansion", async () => {
    await expect(consumer({ ...baseIntent, request: { ...baseIntent.request, capabilities: ["channel.write"] } } as any).process("workspace", "intent")).rejects.toMatchObject({ code: "capability_not_allowed" });
    await expect(consumer({ ...baseIntent, request: { ...baseIntent.request, registered_open_origins: ["https://other.example"] } } as any).process("workspace", "intent")).rejects.toMatchObject({ code: "launch_origin_not_allowed" });
    await expect(consumer(baseIntent as any, { ...app, updatedAt: "version-2" }).process("workspace", "intent")).rejects.toMatchObject({ code: "stale_app_version" });
  });

  test("treats an already active intent as an idempotent replay", async () => {
    await expect(consumer({ ...baseIntent, status: "active" } as any).process("workspace", "intent")).resolves.toMatchObject({ status: "active", replayed: true });
  });
});

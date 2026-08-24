import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import { resolveWappAllowedNpubs } from "./scope-access";
import { buildFlightDeckWappRecordPayload } from "./wapp-publisher";
import { buildWappRuntimeEnv, getWappRuntimeEnvForWapp } from "./runtime-env";
import { WappStore } from "./wapp-store";

async function withStore(fn: (store: WappStore, dbPath: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "wapps-store-"));
  const dbPath = join(dir, "wapps.sqlite");
  try {
    await fn(new WappStore(dbPath), dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("WApp store and helpers", () => {
  test("creates and updates WApp assignment records", () => withStore((store) => {
    const record = store.create({
      id: "wapp-1",
      appId: "app-1",
      title: "Ops Board",
      ownerNpub: "npub1owner",
      createdByNpub: "npub1creator",
      workspaceOwnerNpub: "npub1workspace",
      scopeId: "scope-1",
      scopeLineage: { l1Id: "l1" },
      allowedNpubs: ["npub1owner", "npub1member"],
      launchUrl: "https://apps.example/wapp",
      sourceWingmanUrl: "http://localhost:3000",
      subdomainAlias: "quiet-river",
    });

    expect(record.scopeLineage).toMatchObject({ scopeId: "scope-1", l1Id: "l1" });
    expect(record).toMatchObject({
      id: "wapp-1",
      wappInstallationId: "wapp-1",
      registeredOpenOrigins: ["https://apps.example"],
    });
    expect(store.getByAppId("app-1")?.id).toBe("wapp-1");

    const updated = store.update("wapp-1", { allowedNpubs: ["npub1owner"] });
    expect(updated?.allowedNpubs).toEqual(["npub1owner"]);
  }));

  test("derives allowlist from owner plus supplied scope members", () => {
    expect(resolveWappAllowedNpubs({
      scopeId: "scope-1",
      ownerNpub: "npub1owner",
      memberNpubs: ["npub1member", "npub1owner", ""],
    })).toEqual(["npub1member", "npub1owner"]);
  });

  test("builds Flight Deck wapp record payload", () => withStore((store) => {
    const record = store.create({
      id: "wapp-2",
      appId: "app-2",
      title: "Client Portal",
      ownerNpub: "npub1owner",
      createdByNpub: "npub1creator",
      workspaceOwnerNpub: "npub1workspace",
      scopeId: "scope-2",
      scopeLineage: { l2Id: "l2" },
      allowedNpubs: ["npub1owner"],
      launchUrl: "/host/client-portal",
    });
    const payload = buildFlightDeckWappRecordPayload(record, "npub1flightdeck");
    expect(payload).toMatchObject({
      app_namespace: "npub1flightdeck",
      collection_space: "wapp",
      schema_version: 1,
      record_id: "wapp-2",
      data: {
        wapp_id: "wapp-2",
        app_id: "app-2",
        scope_l2_id: "l2",
      },
      encrypt_to_npubs: ["npub1owner"],
    });
  }));

  test("builds runtime env with WApp db path under app root", () => withStore((store) => {
    const record = store.create({
      id: "wapp-3",
      appId: "app-3",
      title: "Field Log",
      ownerNpub: "npub1owner",
      createdByNpub: "npub1creator",
      workspaceOwnerNpub: "npub1workspace",
      scopeId: "scope-3",
      allowedNpubs: ["npub1owner"],
      launchUrl: "/host/field-log",
    });
    expect(buildWappRuntimeEnv(record, "/tmp/wapp")).toMatchObject({
      WAPP_ID: "wapp-3",
      WAPP_INSTALLATION_ID: "wapp-3",
      WAPP_APP_ID: "app-3",
      WAPP_PUBLISHER_NPUB: "",
      WAPP_WORKSPACE_ID: "",
      WAPP_DB_PATH: "/tmp/wapp/data/db.sqlite",
    });
    expect(buildWappRuntimeEnv(record, "/tmp/wapp")).not.toHaveProperty("WAPP_NSEC");
  }));

  test("migrates Tower signing keys to broker envelopes and clears SQLite custody", () => withStore(async (store, dbPath) => {
    const binding = store.createTowerBinding({
      id: "binding-1",
      label: "Dev Tower",
      towerUrl: "https://tower.example",
      workspaceId: "workspace-1",
      workspaceOwnerNpub: "npub1workspace",
      userAlias: "tester",
      isDefault: true,
    });
    const importedSecret = generateSecretKey();
    const importedNsec = nip19.nsecEncode(importedSecret);
    const importedNpub = nip19.npubEncode(getPublicKey(importedSecret));

    const record = store.create({
      id: "wapp-tower",
      appId: "app-tower",
      title: "Tower App",
      ownerNpub: "npub1owner",
      createdByNpub: "npub1creator",
      workspaceOwnerNpub: "npub1workspace",
      scopeId: "scope-tower",
      allowedNpubs: ["npub1owner"],
      launchUrl: "/host/tower",
      towerBindingId: binding.id,
      appKeyMode: "import",
      appNsec: importedNsec,
    });

    expect(record.towerBinding).toMatchObject({ id: "binding-1", towerUrl: "https://tower.example" });
    expect(record.appNpub).toBe(importedNpub);
    expect(record.publisherNpub).toBe(importedNpub);
    expect(await store.withAppSigningKey(record.id, (nsec) => nsec)).toBe(importedNsec);
    expect(JSON.stringify(record)).not.toContain(importedNsec);
    const inspection = new Database(dbPath, { readonly: true });
    const custody = inspection.query("SELECT app_nsec_encrypted FROM wapp_records WHERE id = ?").get(record.id) as { app_nsec_encrypted: string | null };
    expect(custody.app_nsec_encrypted).toBeNull();
    inspection.close();

    const regenerated = store.update(record.id, { title: "Tower App Updated" });
    expect(regenerated?.appNpub).toBe(importedNpub);
    expect(await store.withAppSigningKey(record.id, (nsec) => nsec)).toBe(importedNsec);
    expect(store.getDefaultTowerBinding()?.id).toBe("binding-1");
    expect(() => getWappRuntimeEnvForWapp(record.id, "/tmp/wapp", store)).toThrow(
      "installation-scoped NIP-98 signing broker capability",
    );
  }));

  test("migrates legacy records while preserving the installation id", () => {
    const dir = mkdtempSync(join(tmpdir(), "wapps-legacy-"));
    const dbPath = join(dir, "wapps.sqlite");
    try {
      const db = new Database(dbPath);
      db.run(`CREATE TABLE wapp_records (
        id TEXT PRIMARY KEY, app_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
        owner_npub TEXT NOT NULL, created_by_npub TEXT NOT NULL, workspace_owner_npub TEXT NOT NULL,
        scope_id TEXT NOT NULL, scope_lineage_json TEXT NOT NULL, allowed_npubs_json TEXT NOT NULL,
        launch_url TEXT NOT NULL, source_wingman_url TEXT, subdomain_alias TEXT, record_state TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_published_at TEXT
      )`);
      db.query(`INSERT INTO wapp_records VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'active', ?, ?, NULL)`).run(
        "legacy-installation", "legacy-app", "Legacy", "npub1owner", "npub1creator", "npub1workspace",
        "scope-1", JSON.stringify({ scopeId: "scope-1", l1Id: null, l2Id: null, l3Id: null, l4Id: null, l5Id: null }),
        JSON.stringify(["npub1owner"]), "https://legacy.example/path",
        "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z",
      );
      db.close();
      const migrated = new WappStore(dbPath).get("legacy-installation");
      expect(migrated).toMatchObject({
        id: "legacy-installation",
        wappInstallationId: "legacy-installation",
        publisherNpub: null,
        registeredOpenOrigins: ["https://legacy.example"],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stages and activates an approved publisher key without changing installation identity", () => withStore(async (store) => {
    store.createTowerBinding({
      id: "binding-rotate",
      label: "Tower",
      towerUrl: "https://tower.example",
      workspaceOwnerNpub: "npub1workspace",
    });
    const initialNsec = nip19.nsecEncode(generateSecretKey());
    const record = store.create({
      id: "stable-installation",
      appId: "app-rotate",
      title: "Rotate",
      ownerNpub: "npub1owner",
      createdByNpub: "npub1creator",
      workspaceOwnerNpub: "npub1workspace",
      scopeId: "scope-1",
      allowedNpubs: ["npub1owner"],
      launchUrl: "https://rotate.example",
      towerBindingId: "binding-rotate",
      appKeyMode: "import",
      appNsec: initialNsec,
    });
    const replacementNsec = nip19.nsecEncode(generateSecretKey());
    const staged = store.stagePublisherKey(record.id, "import", replacementNsec);
    expect(staged?.publisherNpub).toBe(record.publisherNpub);
    expect(staged?.pendingPublisherNpub).not.toBe(record.publisherNpub);
    expect(await store.withAppSigningKey(record.id, (nsec) => nsec)).toBe(initialNsec);
    expect(await store.withAppSigningKey(record.id, (nsec) => nsec, true)).toBe(replacementNsec);
    const rotated = await store.activatePendingPublisherKey(record.id);
    expect(rotated?.id).toBe("stable-installation");
    expect(rotated?.wappInstallationId).toBe("stable-installation");
    expect(rotated?.publisherNpub).not.toBe(record.publisherNpub);
    expect(rotated?.pendingPublisherNpub).toBeNull();
    expect(await store.withAppSigningKey(record.id, (nsec) => nsec)).toBe(replacementNsec);
  }));

  test("preserves existing Tower app keys across binding updates and rejects replacement", () => withStore(async (store) => {
    const firstBinding = store.createTowerBinding({
      id: "binding-1",
      label: "Dev Tower",
      towerUrl: "https://tower-dev.example",
      workspaceOwnerNpub: "npub1workspace",
    });
    const secondBinding = store.createTowerBinding({
      id: "binding-2",
      label: "Stage Tower",
      towerUrl: "https://tower-stage.example",
      workspaceOwnerNpub: "npub1workspace",
    });
    const importedSecret = generateSecretKey();
    const importedNsec = nip19.nsecEncode(importedSecret);
    const importedNpub = nip19.npubEncode(getPublicKey(importedSecret));
    const replacementNsec = nip19.nsecEncode(generateSecretKey());
    const record = store.create({
      id: "wapp-tower-switch",
      appId: "app-tower-switch",
      title: "Tower Switch",
      ownerNpub: "npub1owner",
      createdByNpub: "npub1creator",
      workspaceOwnerNpub: "npub1workspace",
      scopeId: "scope-tower-switch",
      allowedNpubs: ["npub1owner"],
      launchUrl: "/host/tower-switch",
      towerBindingId: firstBinding.id,
      appKeyMode: "import",
      appNsec: importedNsec,
    });

    const switched = store.update(record.id, {
      title: "Tower Switch Updated",
      towerBindingId: secondBinding.id,
    });

    expect(switched?.towerBindingId).toBe(secondBinding.id);
    expect(switched?.appNpub).toBe(importedNpub);
    expect(await store.withAppSigningKey(record.id, (nsec) => nsec)).toBe(importedNsec);
    expect(() => store.update(record.id, { appKeyMode: "generate" })).toThrow("WApp app key replacement is not supported");
    expect(() => store.update(record.id, { appKeyMode: "import", appNsec: replacementNsec })).toThrow("WApp app key replacement is not supported");
    expect(store.get(record.id)?.appNpub).toBe(importedNpub);
    expect(await store.withAppSigningKey(record.id, (nsec) => nsec)).toBe(importedNsec);
  }));

});

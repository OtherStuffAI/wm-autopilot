import { RemoteStorageError } from "../wapps/remote-storage-contract";
import { expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { getPublicKey, nip19 } from "nostr-tools";
import { WappStore } from "../wapps/wapp-store";
import { RemoteStorageBroker } from "../wapps/remote-storage-broker";
import { appCommand } from "./app-command";
import type { AppRecord } from "./app-registry";

const environments: Record<string, string>[] = [];
let startFails = false;
mock.module("../agents/ecosystem-generator", () => ({
  addUserAppToEcosystem: async (input: { wappRuntimeEnv: Record<string, string> }) => {
    environments.push(input.wappRuntimeEnv);
    return { ecosystemPath: "/tmp/storage-fixture.config.cjs", processName: "storage-fixture", logsDir: "/tmp/storage-fixture-logs" };
  },
  getLogsDirectory: () => "/tmp/storage-fixture-logs",
  removeAppFromEcosystem: async () => {}, generateAppProcessName: () => "storage-fixture", getEcosystemPath: () => "/tmp/storage-fixture.config.cjs",
}));
mock.module("../agents/pm2-wrapper", () => ({
  listProcesses: async () => [], deleteProcess: async () => {}, getProcessByName: async () => null,
  getProcessRuntimeInfo: async () => ({ pid: 1234, status: "online" }),
  startProcessFromConfig: async () => { if (startFails) throw new Error("fixture start failed"); }, stopProcess: async () => {},
}));
mock.module("../utils/port-utils", () => ({
  getListeningPortForPid: async () => 4100, isPortAvailable: () => true,
  waitForAvailableTcpPort: async () => true, waitForListeningPort: async () => 4100, waitForTcpPort: async () => true,
}));
const { AppProcessManager } = await import("./app-process-manager");
const { WappTowerDbRequestBroker } = await import("../wapps/tower-db-request-broker");

test("managed storage lifecycle renews on restart, revokes on stop/failure, excludes setup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "app-storage-lifecycle-"));
  const store = new WappStore(join(directory, "wapps.sqlite"));
  const owner = nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(71)));
  store.createTowerBinding({ id: "source", label: "Source", towerUrl: "https://source.example", workspaceOwnerNpub: owner });
  const wapp = store.create({ id: "install", appId: "backup", ownerNpub: owner, createdByNpub: owner, title: "Fixture",
    workspaceOwnerNpub: owner, scopeId: "scope", allowedNpubs: [owner], launchUrl: "https://app.example", towerBindingId: "source" });
  const grants = [{ grantId: "grant", revision: "1", installationId: wapp.id, appId: wapp.appId, ownerNpub: owner,
    appNpub: wapp.appNpub!, towerBindingId: "source", origin: "https://destination.example",
    serviceNpub: nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(72))), workspaceId: randomUUID(), delegationId: randomUUID(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), maxObjectBytes: 64, billing: "operator_budget" as const }];
  let configBad = false;
  const storage = new RemoteStorageBroker({ store, grants: () => { if (configBad) throw new RemoteStorageError("storage_config_invalid", 503); return grants; }, forbiddenSigner: () => false });
  const dbBroker = new WappTowerDbRequestBroker({ store, fetchImpl: async () => Response.json({ namespace: "ready" }) });
  const app: AppRecord = { id: "backup", root: directory, label: "Backup", ownerNpub: owner,
    scripts: { start: appCommand("bun", "start"), setup: appCommand("bun", "setup") },
    env: { WAPP_REMOTE_STORAGE_CAPABILITY: "persisted-token-must-not-leak" },
    tmuxSession: "storage-fixture", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), webApp: true, webAppPort: 4100 };
  const oneShotEnvs: Record<string, string>[] = [];
  const spawn = ((_cmd: unknown, options: { env: Record<string, string> }) => {
    oneShotEnvs.push(options.env);
    return { stdout: new Blob([""]).stream(), stderr: new Blob([""]).stream(), exited: Promise.resolve(0) };
  }) as unknown as typeof Bun.spawn;
  const registry = { getApp: async () => app, updateApp: async (_id: string, updates: Partial<AppRecord>) => Object.assign(app, updates), listApps: async () => [app] };
  const fips = { start: async () => {}, stop: async () => {}, getEndpoint: () => null };
  const manager = new AppProcessManager(registry as any, [], store, null, { register: async () => ({}) } as any,
    spawn, dbBroker, fips as any, storage);
  try {
    startFails = false;
    await manager.start(app.id);
    const first = environments.at(-1)!.WAPP_REMOTE_STORAGE_CAPABILITY!;
    expect(first).toHaveLength(43);
    await manager.restart(app.id);
    const second = environments.at(-1)!.WAPP_REMOTE_STORAGE_CAPABILITY!;
    expect(second).not.toBe(first);
    await expect(storage.request(first, { operation: "status" })).rejects.toMatchObject({ code: "capability_invalid" });
    await manager.stop(app.id);
    await expect(storage.request(second, { operation: "status" })).rejects.toMatchObject({ code: "capability_invalid" });
    await manager.setup(app.id);
    expect(oneShotEnvs).toHaveLength(1);
    expect(oneShotEnvs[0]).not.toHaveProperty("WAPP_REMOTE_STORAGE_CAPABILITY");
    startFails = true;
    await expect(manager.start(app.id)).rejects.toThrow("fixture start failed");
    const failed = environments.at(-1)!.WAPP_REMOTE_STORAGE_CAPABILITY!;
    await expect(storage.request(failed, { operation: "status" })).rejects.toMatchObject({ code: "capability_invalid" });
    configBad = true;
    startFails = false;
    await manager.start(app.id);
    expect(environments.at(-1)).toMatchObject({ WAPP_REMOTE_STORAGE_ERROR: "storage_config_invalid" });
    expect(environments.at(-1)).not.toHaveProperty("WAPP_REMOTE_STORAGE_CAPABILITY");
    configBad = false;
    grants.length = 0;
    startFails = false;
    await manager.start(app.id);
    expect(environments.at(-1)).not.toHaveProperty("WAPP_REMOTE_STORAGE_CAPABILITY");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

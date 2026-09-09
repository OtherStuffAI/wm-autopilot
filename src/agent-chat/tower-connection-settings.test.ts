import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { BackendConnectionStore } from "./backend-connection-store";
import { createTowerConnection, saveTowerConnectionTransport } from "./tower-connection-settings";
import type { WorkspaceSubscriptionRecord } from "./types";

const service = "npub1vf3h0rmlrr0x6pjc68jcrk5p2zsfzl3f9zwcppcdn8386npdlxgqmam99v";
const endpoint = "http://npub109684nue495hq240u3dqzyf2kltk23u3mqkk9l44ga6szed4jcysramf74.fips:43100";
const fips = { mode: "fips", fipsEndpoint: endpoint, expectedServiceNpub: service, httpsEndpoint: null };

test("legacy records load as HTTPS and FIPS-only connections survive database reopen", () => {
  const path = join(tmpdir(), `tower-migration-${randomUUID()}.sqlite`);
  const store = new BackendConnectionStore(path);
  const legacy = store.save(store.createDefault({ managedByNpub: "owner", backendBaseUrl: "http://localhost:3100" }));
  const db = new Database(path);
  db.exec("DELETE FROM backend_connection_transports"); db.close();
  expect(new BackendConnectionStore(path).getById(legacy.backendConnectionId)?.transport).toEqual({
    mode: "https", httpsEndpoint: "http://localhost:3100", fipsEndpoint: null, expectedServiceNpub: null,
  });
  const mesh = createTowerConnection(store, "owner", { transport: fips });
  const reloaded = new BackendConnectionStore(path).getById(mesh.backendConnectionId)!;
  expect(reloaded.backendBaseUrl).toBe(endpoint);
  expect(reloaded.transport).toEqual(fips);
});

test("switch retains subscription IDs/cursors and reconnects only this connection", async () => {
  const store = new BackendConnectionStore(join(tmpdir(), `tower-switch-${randomUUID()}.sqlite`));
  const backend = store.save(store.createDefault({ managedByNpub: "owner", backendBaseUrl: "https://tower.example", serviceNpub: service }));
  const subscriptions = [
    { backendConnectionId: backend.backendConnectionId, subscriptionId: "stable", lastSyncCursor: "cursor", lastSseEventId: "event" },
    { backendConnectionId: "other", subscriptionId: "unrelated", lastSyncCursor: "other-cursor" },
  ] as WorkspaceSubscriptionRecord[];
  const before = JSON.stringify(subscriptions);
  const reconnected: string[] = [];
  const saved = await saveTowerConnectionTransport({ store, id: backend.backendConnectionId, managerNpub: "owner", transport: fips,
    subscriptions, reconnect: async (record) => { reconnected.push(record.subscriptionId); } });
  expect(saved.backendConnectionId).toBe(backend.backendConnectionId);
  expect(saved.backendBaseUrl).toBe(backend.backendBaseUrl);
  expect(JSON.stringify(subscriptions)).toBe(before);
  expect(reconnected).toEqual(["stable"]);
  await expect(saveTowerConnectionTransport({ store, id: backend.backendConnectionId, managerNpub: "foreign", transport: fips,
    subscriptions, reconnect: async () => {} })).rejects.toThrow("owner");
});

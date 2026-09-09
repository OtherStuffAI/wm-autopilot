import type { BackendConnectionStore } from "./backend-connection-store";
import { effectiveTowerEndpoint, normalizeTowerTransport } from "./tower-transport-config";
import { transportForConnection } from "./tower-transport-runtime";
import type { BackendConnectionRecord, WorkspaceSubscriptionRecord } from "./types";

export function ownedTowerConnection(store: BackendConnectionStore, id: string, managerNpub: string): BackendConnectionRecord {
  const record = store.getById(id);
  if (!record) throw Object.assign(new Error("Tower connection not found"), { statusCode: 404 });
  if (record.managedByNpub !== managerNpub) throw Object.assign(new Error("Only the Tower connection owner can change or test its transport"), { statusCode: 403 });
  return record;
}

export function createTowerConnection(store: BackendConnectionStore, managerNpub: string, input: Record<string, unknown>) {
  if (!input.transport) throw new Error("Explicit transport approval is required");
  const transport = normalizeTowerTransport(input.transport, "");
  const endpoint = effectiveTowerEndpoint(transport);
  const record = store.createDefault({ managedByNpub: managerNpub, backendBaseUrl: endpoint,
    serviceNpub: transport.expectedServiceNpub,
    setupWorkspaceOwnerNpub: typeof input.workspaceOwnerNpub === "string" ? input.workspaceOwnerNpub : null,
    setupSourceAppNpub: typeof input.sourceAppNpub === "string" ? input.sourceAppNpub : null,
  });
  return store.save({ ...record, transport });
}

export async function saveTowerConnectionTransport(input: {
  store: BackendConnectionStore;
  id: string;
  managerNpub: string;
  transport: unknown;
  subscriptions: WorkspaceSubscriptionRecord[];
  quiesce?: (subscription: WorkspaceSubscriptionRecord) => Promise<void>;
  reconnect: (subscription: WorkspaceSubscriptionRecord) => Promise<void>;
}) {
  const record = ownedTowerConnection(input.store, input.id, input.managerNpub);
  if (!input.transport) throw new Error("Explicit transport approval is required");
  const transport = normalizeTowerTransport(input.transport, record.backendBaseUrl);
  if (record.serviceNpub && transport.expectedServiceNpub && record.serviceNpub !== transport.expectedServiceNpub) {
    throw new Error("Expected service identity differs from this Tower connection");
  }
  const next = { ...record, transport, updatedAt: new Date().toISOString() };
  // Validate before persistence; selecting an unavailable mesh remains allowed and visibly unhealthy.
  effectiveTowerEndpoint(transport);
  for (const subscription of input.subscriptions.filter((item) => item.backendConnectionId === input.id)) {
    await input.quiesce?.(subscription);
  }
  const saved = input.store.save(next);
  transportForConnection(saved); // Abort the obsolete request/stream generation immediately.
  const failures: string[] = [];
  for (const subscription of input.subscriptions.filter((item) => item.backendConnectionId === input.id)) {
    if (subscription.sseStatus === "disabled" || subscription.lifecycleStatus === "revoked") continue;
    try { await input.reconnect(subscription); }
    catch { failures.push(subscription.subscriptionId); }
  }
  if (failures.length) throw new Error(`Transport saved; subscriptions failed to reconnect: ${failures.join(", ")}`);
  return saved;
}

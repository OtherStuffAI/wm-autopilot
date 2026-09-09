import type { BackendConnectionRecord, WorkspaceSubscriptionRecord } from "./types";

export interface TowerRequestContext {
  backendConnectionId?: string | null;
  subscriptionId?: string | null;
}

/** Resolve only the caller's durable binding; an origin is never an authority selector. */
export function resolveTowerRequestConnection(context: TowerRequestContext, stores: {
  connection: (id: string) => BackendConnectionRecord | null;
  subscription: (id: string) => WorkspaceSubscriptionRecord | null;
}): BackendConnectionRecord | null {
  let id = context.backendConnectionId;
  if (context.subscriptionId) {
    const subscription = stores.subscription(context.subscriptionId);
    if (!subscription) throw new Error("Tower request subscription is missing");
    if (id && id !== subscription.backendConnectionId) throw new Error("Tower request connection differs from its subscription");
    id = subscription.backendConnectionId;
  }
  if (!id) return null;
  const record = stores.connection(id);
  if (!record) throw new Error("Tower request connection is missing");
  return record;
}

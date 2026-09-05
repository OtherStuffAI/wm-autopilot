import type { WappRecord } from "./types";
import type { WappStore } from "./wapp-store";
import { TowerWappActivityRoutes, WappPublishingClient, WappPublishingError, type WappPublishingFetch } from "./wapp-publishing-client";

export async function withManagedPublishingClient<T>(
  store: WappStore,
  wapp: WappRecord,
  operation: (client: WappPublishingClient) => Promise<T>,
  fetchImpl?: WappPublishingFetch,
): Promise<T> {
  const binding = wapp.towerBindingId ? store.getTowerBinding(wapp.towerBindingId) : null;
  if (!binding?.workspaceId || !wapp.publisherNpub) {
    throw new WappPublishingError({ code: "publishing_configuration_missing", category: "permanent" });
  }
  let custodyOpened = false;
  try {
    return await store.withAppSigningKey(wapp.id, async (nsec) => {
      custodyOpened = true;
      const client = new WappPublishingClient({
        towerUrl: binding.towerUrl, workspaceId: binding.workspaceId!,
        wappInstallationId: wapp.wappInstallationId, publisherNpub: wapp.publisherNpub!,
        nsec, routes: TowerWappActivityRoutes, fetchImpl,
      });
      try { return await operation(client); }
      finally { client.stop(); }
    });
  } catch (error) {
    if (!custodyOpened) {
      throw new WappPublishingError({ code: "publisher_custody_unavailable", category: "permanent" });
    }
    throw error;
  }
}

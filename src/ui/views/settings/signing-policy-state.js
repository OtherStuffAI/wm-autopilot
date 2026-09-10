import Dexie from "/vendor/dexie/dexie.mjs";
import Alpine from "/vendor/alpinejs/module.esm.js";
import { loadSigningPolicies, loadSigningPolicy } from "../../services/signing-policies.js";

const db = new Dexie("WingmanSigningPolicies");
db.version(1).stores({ views: "id, syncedAt" });

// Each mounted admin view has its own cache key. Never hydrate another login's
// cached permissions or show an offline cache as current signing authority.
export function createSigningPolicyState(onSnapshot, onError) {
  const id = crypto.randomUUID();
  const storeName = `signingPolicies_${id}`;
  Alpine.store(storeName, { snapshot: null });
  const subscription = Dexie.liveQuery(() => db.views.get(id)).subscribe({
    next(row) {
      if (!row) return;
      Alpine.store(storeName).snapshot = row;
      onSnapshot(Alpine.store(storeName).snapshot);
    },
    error: onError,
  });
  let generation = 0;
  return {
    async refresh(preferredId, notice) {
      const request = ++generation;
      try {
        const inventory = await loadSigningPolicies();
        if (!Array.isArray(inventory.policies)) throw new Error("Signing policy inventory is missing.");
        const selectedId = inventory.policies.some((policy) => policy.id === preferredId)
          ? preferredId : inventory.policies[0]?.id || null;
        const detail = selectedId ? await loadSigningPolicy(selectedId) : null;
        if (selectedId && (!detail?.policy || !Array.isArray(detail.sessions))) {
          throw new Error("Selected policy details or affected sessions are missing.");
        }
        if (request !== generation) return;
        await db.views.put({ id, inventory, selectedId, detail, notice, syncedAt: Date.now() });
      } catch (error) {
        if (request === generation) throw error;
      }
    },
    async destroy() {
      generation++;
      subscription.unsubscribe();
      Alpine.store(storeName, null);
      await db.views.delete(id);
    },
  };
}

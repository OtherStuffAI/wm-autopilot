import Dexie from "/vendor/dexie/dexie.mjs";
import Alpine from "/vendor/alpinejs/module.esm.js";
import { loadSigningPolicies } from "../../services/signing-policies.js";

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
        if (!Array.isArray(inventory.modes)) throw new Error("Signing mode inventory is missing.");
        const selectedId = typeof preferredId === "string" ? preferredId : inventory.activeMode;
        const detail = null;
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

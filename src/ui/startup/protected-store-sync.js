export async function syncAuthenticatedStartupStores({ Alpine = globalThis.Alpine } = {}) {
  if (!Alpine || typeof Alpine.store !== "function") return;

  const scheduler = Alpine.store("scheduler");
  const syncs = [];

  if (scheduler && typeof scheduler.sync === "function") {
    syncs.push(
      scheduler.sync().catch((error) => {
        console.warn("[scheduler-store] authenticated startup sync failed:", error);
      }),
    );
  }

  await Promise.all(syncs);
}

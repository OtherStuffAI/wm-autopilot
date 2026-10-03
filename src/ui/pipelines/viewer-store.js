import Dexie from "/vendor/dexie/dexie.mjs";

const db = new Dexie("WingmanNativePipelineViewer");
db.version(1).stores({ projections: "id" });
db.version(2)
  .stores({ projections: "id" })
  .upgrade((tx) => tx.table("projections").clear());

// A mount gets a new partition and starts with a fresh authorized response.
// No offline replay of an old actor's summary is permitted.
export function createNativeViewerStore() {
  const id = crypto.randomUUID();
  let disposed = false;
  let writes = Promise.resolve();
  let privateProjection = null;
  let revision = 0;
  return {
    publish(record) {
      writes = writes.then(async () => {
        if (disposed) return;
        privateProjection = record;
        // Definitions can contain private literals in descriptive metadata.
        // Persist only UI notification state; all server content is ephemeral.
        await db.projections.put({
          id,
          status: record.status,
          revision: ++revision,
        });
      });
      return writes;
    },
    observe(callback) {
      return Dexie.liveQuery(() => db.projections.get(id)).subscribe({
        next: (record) => {
          if (!disposed && record && privateProjection)
            callback(privateProjection);
        },
        error: () => {
          if (!disposed)
            callback({
              status: "unavailable",
              reason: "Viewer summary storage unavailable",
              snapshot: null,
            });
        },
      });
    },
    async dispose() {
      disposed = true;
      privateProjection = null;
      await writes;
      await db.projections.delete(id);
    },
  };
}

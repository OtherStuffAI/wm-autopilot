/**
 * Dexie database for persistent Scheduler data.
 * Stores jobs in IndexedDB for instant page loads.
 */

import Dexie from "/vendor/dexie/dexie.mjs";

export const schedulerDb = new Dexie("WingmanScheduler");

schedulerDb.version(1).stores({
  jobs: "id, userNpub, enabled, createdAt",
});

schedulerDb.version(2).stores({
  jobs: "id, userNpub, enabled, triggerType, createdAt",
});

schedulerDb.version(3).stores({
  jobs: "id, userNpub, enabled, triggerType, createdAt",
});

/**
 * Job store operations.
 */
export const JobStore = {
  async getAll() {
    return schedulerDb.jobs.orderBy("createdAt").reverse().toArray();
  },

  async upsertMany(jobs) {
    if (!Array.isArray(jobs) || jobs.length === 0) return;
    await schedulerDb.jobs.bulkPut(jobs);
  },

  async remove(id) {
    return schedulerDb.jobs.delete(id);
  },

  async clear() {
    return schedulerDb.jobs.clear();
  },
};

export { Dexie };

/**
 * Dexie database for persistent Night Watch data.
 * Stores report cards and config in IndexedDB for instant page loads.
 */

import Dexie from "/vendor/dexie/dexie.mjs";

// Create database instance (separate from WingmanLive)
export const nwDb = new Dexie("WingmanNightWatch");

// Define schema
// Version 1: reports and config tables
nwDb.version(1).stores({
  // Reports table — server-provided UUID as primary key
  // Indexes: sessionId for lookups, status for filtering, createdAt for ordering
  reports: "id, sessionId, status, createdAt",
  // Config table — single row keyed "current"
  config: "key",
});

/**
 * Report store operations.
 */
export const ReportStore = {
  /** Get all cached reports, ordered by createdAt descending. */
  async getAll() {
    return nwDb.reports.orderBy("createdAt").reverse().toArray();
  },

  /** Bulk upsert reports from server response. */
  async upsertMany(reports) {
    if (!Array.isArray(reports) || reports.length === 0) return;
    await nwDb.reports.bulkPut(reports);
  },

  /** Remove a single report by id. */
  async remove(id) {
    return nwDb.reports.delete(id);
  },

  /** Clear all cached reports. */
  async clear() {
    return nwDb.reports.clear();
  },
};

/**
 * Config store operations.
 * Stores the full config object under key = "current".
 */
export const ConfigStore = {
  /** Get cached config (or null if not cached). */
  async get() {
    const row = await nwDb.config.get("current");
    return row ? row.data : null;
  },

  /** Cache the config object. */
  async put(config) {
    return nwDb.config.put({ key: "current", data: config });
  },
};

// Re-export Dexie for liveQuery usage
export { Dexie };

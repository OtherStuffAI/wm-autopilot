/**
 * Night Watch Alpine Store
 *
 * Registers Alpine.store("nightwatch") backed by Dexie for instant page loads.
 * Follows the same pattern as live/chat-component.js:
 *   Alpine store + Dexie liveQuery subscription.
 */

import Alpine from "/vendor/alpinejs/module.esm.js";
import { Dexie, nwDb, ReportStore, ConfigStore } from "./db.js";
import {
  fetchNightWatchConfig,
  updateNightWatchConfig,
  fetchNightWatchReports,
  deleteNightWatchReport,
} from "./api.js";
import { STATUS_COLORS, STATUS_LABELS } from "./helpers.js";

/**
 * Initialize the Night Watch Alpine store.
 * Call once during app bootstrap (before Alpine.start).
 */
export function initNightWatchStore({ showToast, syncOnInit = true }) {
  Alpine.store("nightwatch", {
    // ----- State -----
    reports: [],
    config: null,
    filterProject: "",
    filterStatus: "",
    loading: false,
    initialized: false,
    _liveQuerySub: null,

    // ----- Lifecycle -----

    /** Load from Dexie instantly, then background-sync from API. */
    async init() {
      if (this.initialized) return;
      this.loading = true;

      try {
        // 1. Instant render from Dexie cache
        const [cachedReports, cachedConfig] = await Promise.all([
          ReportStore.getAll(),
          ConfigStore.get(),
        ]);
        this.reports = cachedReports;
        if (cachedConfig) this.config = cachedConfig;

        // 2. Set up liveQuery so Dexie changes auto-update Alpine
        this._setupLiveQuery();

        this.initialized = true;
        this.loading = false;

        // 3. Background-sync from server unless bootstrap owns auth sequencing.
        if (syncOnInit) {
          void this.sync();
        }
      } catch (err) {
        console.error("[nightwatch-store] init failed:", err);
        this.loading = false;
      }
    },

    /** Subscribe to Dexie liveQuery on reports table. */
    _setupLiveQuery() {
      if (this._liveQuerySub) {
        this._liveQuerySub.unsubscribe();
      }

      const observable = Dexie.liveQuery(() => ReportStore.getAll());
      this._liveQuerySub = observable.subscribe({
        next: (reports) => {
          this.reports = reports;
        },
        error: (err) => {
          console.error("[nightwatch-store] liveQuery error:", err);
        },
      });
    },

    // ----- Server sync -----

    /** Fetch fresh data from API and write to Dexie (triggers liveQuery). */
    async sync() {
      try {
        const [configData, reportsData] = await Promise.all([
          fetchNightWatchConfig(),
          fetchNightWatchReports(),
        ]);

        // Update config cache
        const config = {
          intervalMinutes: Number(configData.intervalMinutes) || 5,
          minIntervalMinutes: Number(configData.minIntervalMinutes) || 2,
          maxIntervalMinutes: Number(configData.maxIntervalMinutes) || 60,
          prompt: configData.prompt || "Any progress?",
          maxCycles: configData.maxCycles || 21,
          maxCycleOptions: configData.maxCycleOptions || [6, 21, 256],
        };
        this.config = config;
        await ConfigStore.put(config);

        // Sync reports — replace cache with server truth
        const serverReports = reportsData.reports || [];
        await nwDb.transaction("rw", nwDb.reports, async () => {
          await nwDb.reports.clear();
          if (serverReports.length > 0) {
            await nwDb.reports.bulkPut(serverReports);
          }
        });
        // liveQuery fires -> this.reports updates automatically
      } catch (err) {
        console.warn("[nightwatch-store] sync failed:", err);
      }
    },

    // ----- Actions -----

    /** Dismiss a report: delete from API + remove from Dexie. */
    async dismiss(id) {
      try {
        await deleteNightWatchReport(id);
        await ReportStore.remove(id);
        // liveQuery fires -> Alpine updates
        showToast("Report dismissed");
      } catch (err) {
        showToast(`Failed to dismiss: ${err.message}`, { type: "error" });
      }
    },

    /** Update config: PATCH API + update Dexie cache. */
    async updateConfig(patch) {
      try {
        const data = await updateNightWatchConfig(patch);
        // Unwrap Alpine proxy to plain object for IndexedDB storage
        const current = JSON.parse(JSON.stringify(this.config || {}));
        const updated = {
          ...current,
          intervalMinutes: data.intervalMinutes ?? current.intervalMinutes,
          minIntervalMinutes: data.minIntervalMinutes ?? current.minIntervalMinutes,
          maxIntervalMinutes: data.maxIntervalMinutes ?? current.maxIntervalMinutes,
          prompt: data.prompt ?? current.prompt,
          maxCycles: data.maxCycles ?? current.maxCycles,
          maxCycleOptions: data.maxCycleOptions ?? current.maxCycleOptions,
        };
        this.config = updated;
        await ConfigStore.put(updated);
        return data;
      } catch (err) {
        showToast(`Failed to update config: ${err.message}`, { type: "error" });
        throw err;
      }
    },

    // ----- Computed -----

    /** Filtered reports based on current filter state. */
    get filteredReports() {
      return this.reports.filter((r) => {
        if (this.filterStatus && r.status !== this.filterStatus) return false;
        if (this.filterProject && r.workingDirectory !== this.filterProject) return false;
        return true;
      });
    },

    /** Unique project directories from reports. */
    get uniqueProjects() {
      const dirs = new Set();
      for (const r of this.reports) {
        if (r.workingDirectory) dirs.add(r.workingDirectory);
      }
      return Array.from(dirs).sort();
    },

    // ----- Template helpers -----

    statusColor(status) {
      return STATUS_COLORS[status] || "#6b7280";
    },

    statusLabel(status) {
      return STATUS_LABELS[status] || status;
    },

    extractProject(dir) {
      if (!dir) return null;
      const segments = dir.replace(/\/+$/, "").split("/");
      return segments[segments.length - 1] || null;
    },

    formatTime(iso) {
      try {
        const d = new Date(iso);
        return d.toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
      } catch {
        return iso;
      }
    },

    // ----- Cleanup -----

    cleanup() {
      if (this._liveQuerySub) {
        this._liveQuerySub.unsubscribe();
        this._liveQuerySub = null;
      }
    },
  });
}

// Export Alpine for reuse
export { Alpine };

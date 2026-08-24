/**
 * Scheduler Alpine Store
 *
 * Registers Alpine.store("scheduler") backed by Dexie for instant page loads.
 * Follows the same pattern as nightwatch/store.js.
 */

import Alpine from "/vendor/alpinejs/module.esm.js";
import { Dexie, schedulerDb, JobStore } from "./db.js";
import {
  fetchSchedulerJobs,
  createSchedulerJob,
  updateSchedulerJob,
  deleteSchedulerJob,
  triggerSchedulerJob,
  fetchSchedulerJobRuns,
} from "./api.js";

/**
 * Initialize the Scheduler Alpine store.
 * Call once during app bootstrap (before Alpine.start).
 */
export function initSchedulerStore({ showToast, syncOnInit = true }) {
  Alpine.store("scheduler", {
    // ----- State -----
    jobs: [],
    loading: false,
    initialized: false,
    _liveQuerySub: null,

    // ----- Lifecycle -----

    async init() {
      if (this.initialized) return;
      this.loading = true;

      try {
        const cached = await JobStore.getAll();
        this.jobs = cached;
        this._setupLiveQuery();
        this.initialized = true;
        this.loading = false;
        if (syncOnInit) {
          void this.sync();
        }
      } catch (err) {
        console.error("[scheduler-store] init failed:", err);
        this.loading = false;
      }
    },

    _setupLiveQuery() {
      if (this._liveQuerySub) {
        this._liveQuerySub.unsubscribe();
      }
      const observable = Dexie.liveQuery(() => JobStore.getAll());
      this._liveQuerySub = observable.subscribe({
        next: (jobs) => {
          this.jobs = jobs;
        },
        error: (err) => {
          console.error("[scheduler-store] liveQuery error:", err);
        },
      });
    },

    // ----- Server sync -----

    async sync() {
      try {
        const data = await fetchSchedulerJobs();
        const serverJobs = data.jobs || [];
        await schedulerDb.transaction("rw", schedulerDb.jobs, async () => {
          await schedulerDb.jobs.clear();
          if (serverJobs.length > 0) {
            await schedulerDb.jobs.bulkPut(serverJobs);
          }
        });
        // liveQuery fires -> this.jobs updates
      } catch (err) {
        console.warn("[scheduler-store] sync failed:", err);
      }
    },

    // ----- Actions -----

    async create(data) {
      try {
        const result = await createSchedulerJob(data);
        if (result.job) {
          await JobStore.upsertMany([result.job]);
        }
        showToast("Trigger created");
        return result.job;
      } catch (err) {
        showToast(`Failed to create trigger: ${err.message}`, { type: "error" });
        throw err;
      }
    },

    async update(id, data) {
      try {
        const result = await updateSchedulerJob(id, data);
        if (result.job) {
          await JobStore.upsertMany([result.job]);
        }
        showToast("Trigger updated");
        return result.job;
      } catch (err) {
        showToast(`Failed to update trigger: ${err.message}`, { type: "error" });
        throw err;
      }
    },

    async remove(id) {
      try {
        await deleteSchedulerJob(id);
        await JobStore.remove(id);
        showToast("Trigger deleted");
      } catch (err) {
        showToast(`Failed to delete: ${err.message}`, { type: "error" });
      }
    },

    async trigger(id) {
      try {
        const result = await triggerSchedulerJob(id);
        const label = result.pipelineRunId
          ? `pipeline ${result.pipelineRunId.slice(0, 8)}…`
          : `session ${result.sessionId?.slice(0, 8)}…`;
        showToast(`Triggered — ${label}`);
        await this.sync();
        return result;
      } catch (err) {
        showToast(`Failed to trigger: ${err.message}`, { type: "error" });
        throw err;
      }
    },

    async toggleEnabled(id, enabled) {
      return this.update(id, { enabled });
    },

    // ----- Computed -----

    get enabledJobs() {
      return this.jobs.filter((j) => j.enabled);
    },

    get disabledJobs() {
      return this.jobs.filter((j) => !j.enabled);
    },

    // ----- Helpers -----

    formatTime(iso) {
      if (!iso) return "—";
      try {
        return new Date(iso).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
      } catch {
        return iso;
      }
    },

    cleanup() {
      if (this._liveQuerySub) {
        this._liveQuerySub.unsubscribe();
        this._liveQuerySub = null;
      }
    },
  });
}

export { Alpine };

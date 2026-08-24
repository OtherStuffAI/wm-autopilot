/**
 * Apps Alpine Store
 *
 * Registers Alpine.store("apps") backed by Dexie for instant page loads.
 * Follows the nightwatch store pattern:
 *   Alpine store + Dexie liveQuery subscription.
 *
 * Data flow:
 *   sync() -> fetchAppsApi() -> AppsTable.upsertMany() -> liveQuery fires -> this.items updates
 */

import Alpine from "/vendor/alpinejs/module.esm.js";
import { Dexie, AppsTable } from "../live/db.js";
import {
  fetchAppsApi,
  triggerAppActionApi,
  removeAppApi,
} from "../services/apps.js";

/** Default log preview line count. */
const DEFAULT_TAIL = 5;

/**
 * Normalize an npub value for comparison/filtering.
 */
function normaliseNpub(npub) {
  if (typeof npub !== "string") return null;
  const trimmed = npub.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Initialize the Apps Alpine store.
 * Call once during app bootstrap (before Alpine.start).
 *
 * @param {Object} deps - External dependencies injected from app.js
 * @param {Function} deps.showToast - Toast notification function
 * @param {Function} deps.getIdentity - Returns current identity state object
 * @param {Function} [deps.onUnauthorized] - Called on 401 responses
 * @param {Function} [deps.formatWebAppUrl] - Formats a port number into a full URL
 * @param {boolean} [deps.syncOnInit=true] - Whether init() should immediately sync from the API
 */
export function initAppsStore({
  showToast,
  getIdentity,
  onUnauthorized,
  formatWebAppUrl,
  syncOnInit = true,
}) {
  Alpine.store("apps", {
    // ----- State -----
    items: [],
    loading: false,
    initialized: false,
    error: null,
    pendingOpenDialog: null,
    pendingFocusId: null,
    viewMode: "table",
    filterText: "",
    sort: {
      key: "title",
      direction: "asc",
    },
    filters: {
      npub: "all",
      options: [],
      initialized: false,
    },
    system: {
      restart: {
        loading: false,
        inProgress: false,
        marker: null,
        outcome: null,
        error: null,
        submitting: false,
      },
      cleanup: {
        running: false,
        result: null,
        error: null,
      },
    },
    _liveQuerySub: null,

    // ----- Lifecycle -----

    /** Load from Dexie cache instantly, then background-sync from API. */
    async init() {
      if (this.initialized) return;
      this.loading = true;

      try {
        // 1. Instant render from Dexie cache
        const cachedApps = await AppsTable.getAll();
        if (cachedApps.length > 0) {
          this.items = cachedApps;
          console.log(`[apps-store] Loaded ${cachedApps.length} apps from cache`);
        }

        // 2. Set up liveQuery so Dexie changes auto-update Alpine
        this._setupLiveQuery();

        this.initialized = true;
        this.loading = false;

        // 3. Background-sync from server unless bootstrap owns the first fetch.
        if (syncOnInit) {
          void this.sync();
        }
      } catch (err) {
        console.error("[apps-store] init failed:", err);
        this.loading = false;
      }
    },

    /** Subscribe to Dexie liveQuery on apps table. */
    _setupLiveQuery() {
      if (this._liveQuerySub) {
        this._liveQuerySub.unsubscribe();
      }

      const observable = Dexie.liveQuery(() => AppsTable.getAll());
      this._liveQuerySub = observable.subscribe({
        next: (apps) => {
          this.items = apps;
        },
        error: (err) => {
          console.error("[apps-store] liveQuery error:", err);
        },
      });
    },

    // ----- Server sync -----

    /**
     * Fetch fresh data from API and write to Dexie (triggers liveQuery).
     * @param {Object} [options]
     * @param {number} [options.tail] - Number of log preview lines
     */
    async sync(options = {}) {
      const tail = options.tail ?? DEFAULT_TAIL;

      if (!this.filters.initialized) {
        this.filters.npub = "all";
      }

      this.loading = true;
      try {
        const npubParam = this.filters.npub !== "all"
          ? this.filters.npub
          : undefined;

        const payload = await fetchAppsApi({ tail, npub: npubParam });

        // Handle 401
        if (payload.unauthorized) {
          this.items = [];
          this.filters.options = [];
          this.filters.npub = "all";
          this.filters.initialized = false;
          this.error = "Unauthorized";
          await AppsTable.clear();
          if (onUnauthorized) onUnauthorized();
          return;
        }

        // Transform items with webApp URL resolution
        const rawItems = Array.isArray(payload?.apps) ? payload.apps : [];
        const items = rawItems.map((item) => this._transformAppItem(item));

        // Write to Dexie — liveQuery fires -> this.items updates (async)
        await AppsTable.upsertMany(items);
        // Sync items immediately so callers see fresh data without
        // waiting for the asynchronous liveQuery callback.
        this.items = items;

        // Process filter options (admin only)
        this._processFilters(payload);

        this.error = null;
        console.log(`[apps-store] Synced ${items.length} apps from API`);
      } catch (err) {
        this.error = err instanceof Error ? err.message : "Failed to load apps";
        console.warn("[apps-store] sync failed:", err);
      } finally {
        this.loading = false;
        this.initialized = true;
      }
    },

    /** Transform a raw app item from the API into the expected shape. */
    _transformAppItem(item) {
      const logs = Array.isArray(item?.logs) ? item.logs : [];
      const availableScripts =
        item?.availableScripts && typeof item.availableScripts === "object"
          ? item.availableScripts
          : {
              start: Boolean(item?.scripts?.start),
              stop: Boolean(item?.scripts?.stop),
              restart: Boolean(item?.scripts?.restart),
              build: Boolean(item?.scripts?.build),
            };
      const webApp = Boolean(item?.webApp);
      const webAppPort =
        typeof item?.webAppPort === "number" && Number.isFinite(item.webAppPort)
          ? Math.trunc(item.webAppPort)
          : null;
      const autoStart = Boolean(item?.autoStart ?? item?.auto_start);
      const env = Array.isArray(item?.env)
        ? item.env
            .filter((entry) => entry && typeof entry.key === "string" && entry.key.trim().length > 0)
            .map((entry) => ({ key: entry.key.trim(), hasValue: Boolean(entry.hasValue) }))
        : [];
      let webAppUrl =
        typeof item?.webAppUrl === "string" && item.webAppUrl.length > 0 ? item.webAppUrl : null;
      if (!webAppUrl && webApp && webAppPort !== null && formatWebAppUrl) {
        webAppUrl = formatWebAppUrl(webAppPort);
      }
      return { ...item, autoStart, auto_start: autoStart, env, webApp, webAppPort, webAppUrl, logs, availableScripts };
    },

    /** Process filter options from API response. */
    _processFilters(payload) {
      const filterPayload = payload?.filters && typeof payload.filters === "object" ? payload.filters : null;
      const ownerOptions =
        filterPayload && Array.isArray(filterPayload.npubs) ? filterPayload.npubs : [];
      this.filters.options = ownerOptions;

      const activeValue = filterPayload?.active;
      if (typeof activeValue === "string" && activeValue.length > 0) {
        this.filters.npub = activeValue;
      } else if (activeValue === null) {
        this.filters.npub = "all";
      }
      this.filters.initialized = true;
    },

    // ----- Actions -----

    /** Trigger an action (start/stop/restart/build/setup) on an app. */
    async triggerAction(appId, action) {
      const result = await triggerAppActionApi(appId, action);
      if (result.success) {
        showToast(`${action} triggered for app`);
        await this.sync();
      } else {
        showToast(`Failed: ${result.error}`, { type: "error" });
      }
      return result;
    },

    /** Remove an app. */
    async removeApp(appId, killSession = false) {
      const result = await removeAppApi(appId, killSession);
      if (result.success) {
        await AppsTable.remove(appId);
        await this.sync();
        showToast("App removed");
      } else {
        showToast(`Failed to remove: ${result.error}`, { type: "error" });
      }
      return result;
    },

    // ----- Helpers -----

    /** Get an app by id from cached items. */
    getById(id) {
      return this.items.find((a) => a.id === id) ?? null;
    },

    // ----- Computed -----

    /** Apps filtered by current npub filter. */
    get filteredApps() {
      const filter = this.filters.npub;
      if (!filter || filter === "all") return this.items;
      return this.items.filter((a) => normaliseNpub(a.npub) === filter);
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

export { Alpine };

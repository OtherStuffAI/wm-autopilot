/**
 * Sessions Alpine Store
 *
 * Registers Alpine.store("sessions") backed by Dexie for instant page loads.
 * Follows the nightwatch store pattern:
 *   Alpine store + Dexie liveQuery subscription.
 *
 * Data flow:
 *   sync() -> fetchSessionsApi() -> ApiSessionStore.upsertMany() -> liveQuery fires -> this.items updates
 */

import Alpine from "/vendor/alpinejs/module.esm.js";
import { Dexie, ApiSessionStore } from "../live/db.js";
import { fetchSessionsApi } from "../services/sessions.js";
import { resolveSessionOwnerNpub } from "./ownership.js";
import { sortSessionsForTabs } from "./session-order.js";

/**
 * Normalize an npub value for comparison/filtering.
 * Returns null for empty/invalid values.
 */
function normaliseNpub(npub) {
  if (typeof npub !== "string") return null;
  const trimmed = npub.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Initialize the Sessions Alpine store.
 * Call once during app bootstrap (before Alpine.start).
 *
 * @param {Object} deps - External dependencies injected from app.js
 * @param {Function} deps.showToast - Toast notification function
 * @param {Function} deps.getIdentity - Returns current identity state object
 * @param {Function} [deps.onUnauthorized] - Called on 401 responses
 * @param {Function} [deps.onIdentityUpdate] - Called with identity updates from session data
 * @param {boolean} [deps.syncOnInit=true] - Whether init() should immediately sync from the API
 */
export function initSessionsStore({
  showToast,
  getIdentity,
  onUnauthorized,
  onIdentityUpdate,
  onItemsChanged,
  syncOnInit = true,
}) {
  Alpine.store("sessions", {
    // ----- State -----
    items: [],
    loading: false,
    initialized: false,
    activeSessionId: null,
    lastActiveSessionId: null,
    filters: {
      npub: "all",
      options: [],
      initialized: false,
    },
    identitySummaries: [],
    _liveQuerySub: null,

    // ----- Lifecycle -----

    /** Load from Dexie cache instantly, then background-sync from API. */
    async init() {
      if (this.initialized) return;
      this.loading = true;

      try {
        // 1. Instant render from Dexie cache
        const cachedSessions = await ApiSessionStore.getAll();
        if (cachedSessions.length > 0) {
          this.items = sortSessionsForTabs(cachedSessions);
          console.log(`[sessions-store] Loaded ${cachedSessions.length} sessions from cache`);
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
        console.error("[sessions-store] init failed:", err);
        this.loading = false;
      }
    },

    /** Subscribe to Dexie liveQuery on apiSessions table. */
    _setupLiveQuery() {
      if (this._liveQuerySub) {
        this._liveQuerySub.unsubscribe();
      }

      const observable = Dexie.liveQuery(() => ApiSessionStore.getAll());
      this._liveQuerySub = observable.subscribe({
        next: (sessions) => {
          this.items = sortSessionsForTabs(sessions);
          if (typeof onItemsChanged === "function") {
            onItemsChanged(this.items);
          }
        },
        error: (err) => {
          console.error("[sessions-store] liveQuery error:", err);
        },
      });
    },

    // ----- Server sync -----

    /**
     * Fetch fresh data from API and write to Dexie (triggers liveQuery).
     * Handles filter logic, identity updates, and cleanup.
     */
    async sync() {
      const identity = getIdentity();
      const viewerNormalized = normaliseNpub(identity.npub);

      if (!this.filters.initialized) {
        this.filters.npub = "all";
      }

      try {
        const activeFilter = this.filters.npub;
        const npubParam = activeFilter && activeFilter !== "all" ? activeFilter : undefined;
        const data = await fetchSessionsApi({ npub: npubParam });

        if (!data) return;

        // Handle 401
        if (data.unauthorized) {
          this.items = [];
          this.identitySummaries = [];
          this.filters.options = [];
          this.filters.npub = "all";
          this.filters.initialized = false;
          this.activeSessionId = null;
          this.lastActiveSessionId = null;
          await ApiSessionStore.clear();
          if (onUnauthorized) onUnauthorized();
          return;
        }

        const sessions = Array.isArray(data.sessions) ? data.sessions : [];
        const orderedSessions = sortSessionsForTabs(sessions);
        const identities = Array.isArray(data.identities) ? data.identities : [];
        this.identitySummaries = identities;

        // Write to Dexie — liveQuery fires -> this.items updates (async)
        await ApiSessionStore.upsertMany(orderedSessions);
        // Sync items immediately so callers see fresh data without
        // waiting for the asynchronous liveQuery callback.
        this.items = orderedSessions;
        if (typeof onItemsChanged === "function") {
          onItemsChanged(this.items);
        }

        // Process identity updates for the viewer
        if (onIdentityUpdate) {
          this._processIdentityUpdates(identity, identities, orderedSessions);
        }

        // Process filter options
        this._processFilters(data);

        // Clean up stale lastActiveSessionId
        const sessionIds = new Set(orderedSessions.map((s) => s.id));
        if (this.lastActiveSessionId && !sessionIds.has(this.lastActiveSessionId)) {
          this.lastActiveSessionId = null;
        }

        console.log(`[sessions-store] Synced ${orderedSessions.length} sessions from API`);
      } catch (err) {
        console.warn("[sessions-store] sync failed:", err);
      }
    },

    /** Extract identity updates (alias and ports) from session data. */
    _processIdentityUpdates(identity, identities, sessions) {
      const viewerNpub = normaliseNpub(identity.npub);
      if (!viewerNpub) return;

      const viewerSummary =
        identities.find((s) => s && typeof s.npub === "string" && s.npub === viewerNpub) ??
        identities.find(
          (s) =>
            s &&
            typeof s.normalizedNpub === "string" &&
            s.normalizedNpub === viewerNpub,
        ) ??
        null;

      const currentAlias =
        viewerSummary?.alias ??
        sessions.find(
          (s) => s && typeof s.npub === "string" && s.npub === viewerNpub,
        )?.identityAlias ??
        null;

      const update = { alias: currentAlias };

      if (viewerSummary && Object.prototype.hasOwnProperty.call(viewerSummary, "ports")) {
        update.ports = Array.isArray(viewerSummary.ports) ? viewerSummary.ports : [];
      }

      onIdentityUpdate(update);
    },

    /** Process filter options from API response. */
    _processFilters(data) {
      const filterPayload = data.filters && typeof data.filters === "object" ? data.filters : null;
      const npubOptions =
        filterPayload && Array.isArray(filterPayload.npubs) ? filterPayload.npubs : [];
      this.filters.options = npubOptions;

      const optionValues = new Set([
        "all",
        ...npubOptions
          .filter((o) => o && typeof o === "object" && typeof o.value === "string")
          .map((o) => o.value),
      ]);

      let nextFilter = this.filters.npub;
      if (
        filterPayload &&
        typeof filterPayload.active === "string" &&
        optionValues.has(filterPayload.active)
      ) {
        nextFilter = filterPayload.active;
      } else if (filterPayload && filterPayload.active === null) {
        nextFilter = "all";
      } else if (!optionValues.has(nextFilter)) {
        nextFilter = "all";
      }
      this.filters.npub = nextFilter;
      this.filters.initialized = true;
    },

    // ----- Actions -----

    /** Set the active session ID. */
    setActive(sessionId) {
      if (this.activeSessionId !== sessionId) {
        this.lastActiveSessionId = this.activeSessionId;
        this.activeSessionId = sessionId;
      }
    },

    /** Get a session by id from cached items. */
    getById(id) {
      return this.items.find((s) => s.id === id) ?? null;
    },

    // ----- Computed -----

    /** Sessions filtered by current npub filter. */
    get filteredSessions() {
      const filter = this.filters.npub;
      if (!filter || filter === "all") return this.items;
      return this.items.filter(
        (s) => normaliseNpub(resolveSessionOwnerNpub(s)) === filter,
      );
    },

    /** Sessions currently running. */
    get runningSessions() {
      return this.items.filter(
        (s) => s.status === "running" || s.agentRuntimeStatus === "running",
      );
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

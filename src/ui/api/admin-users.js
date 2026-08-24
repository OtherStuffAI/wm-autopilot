/**
 * Admin user management — CRUD, selection state, picture cache, and ports tools.
 *
 * Depends on: state.adminUsers, state.identity, fetchAdminUserProfile, render (via DI).
 */

import { fetchAdminUserProfile } from "../identity/profile.js";

export function initAdminUsersApi(deps) {
  const {
    state,
    getCurrentRoute,
    render,
    normaliseNpubValue,
    isFiniteNumber,
    ADMIN_PICTURE_CACHE_TTL_MS,
  } = deps;

  // ── Selection state ─────────────────────────────────────────────

  const getAdminUserKey = (user) => {
    if (!user || typeof user !== "object") return null;
    return normaliseNpubValue(user.normalizedNpub ?? user.npub);
  };

  const ensureAdminSelectionState = () => {
    if (!(state.adminUsers.selection instanceof Set)) {
      state.adminUsers.selection = new Set();
    }
    return state.adminUsers.selection;
  };

  const syncAdminSelectionState = (users) => {
    const selection = ensureAdminSelectionState();
    if (!Array.isArray(users)) {
      selection.clear();
      return;
    }
    const validKeys = new Set();
    users.forEach((user) => {
      const key = getAdminUserKey(user);
      if (key) {
        validKeys.add(key);
      }
    });
    Array.from(selection).forEach((key) => {
      if (!validKeys.has(key)) {
        selection.delete(key);
      }
    });
  };

  const setAdminUserSelected = (key, selected) => {
    if (!key) return;
    const selection = ensureAdminSelectionState();
    if (selected) {
      selection.add(key);
    } else {
      selection.delete(key);
    }
  };

  const clearAdminSelection = () => {
    ensureAdminSelectionState().clear();
  };

  const getAdminSelectedUsers = () => {
    const items = Array.isArray(state.adminUsers.items) ? state.adminUsers.items : [];
    const selection = ensureAdminSelectionState();
    return items.filter((user) => {
      const key = getAdminUserKey(user);
      return key ? selection.has(key) : false;
    });
  };

  const getAdminSelectionCount = () => ensureAdminSelectionState().size;

  // ── Nickname drafts ─────────────────────────────────────────────

  const syncAdminNicknameDrafts = (users) => {
    if (!Array.isArray(users) || !(state.adminUsers.nicknameDrafts instanceof Map)) {
      return;
    }
    const drafts = state.adminUsers.nicknameDrafts;
    const validKeys = new Set();
    users.forEach((user) => {
      const key = normaliseNpubValue(user?.normalizedNpub ?? user?.npub);
      if (!key) return;
      validKeys.add(key);
      const nickname =
        typeof user?.nickname === "string" && user.nickname.trim().length > 0 ? user.nickname : "";
      drafts.set(key, nickname);
    });
    Array.from(drafts.keys()).forEach((key) => {
      if (!validKeys.has(key)) {
        drafts.delete(key);
      }
    });
  };

  // ── Picture cache ───────────────────────────────────────────────

  const ensureAdminPictureRequestState = () => {
    if (!(state.adminUsers.pictureRequests instanceof Set)) {
      state.adminUsers.pictureRequests = new Set();
    }
  };

  const ensureAdminPictureCacheState = () => {
    if (!(state.adminUsers.pictureCache instanceof Map)) {
      state.adminUsers.pictureCache = new Map();
    }
  };

  const resolveFreshAdminPictureCache = (key) => {
    ensureAdminPictureCacheState();
    const entry = state.adminUsers.pictureCache.get(key);
    if (!entry || !isFiniteNumber(entry.fetchedAt)) {
      return null;
    }
    if (Date.now() - entry.fetchedAt > ADMIN_PICTURE_CACHE_TTL_MS) {
      return null;
    }
    return entry;
  };

  const memoiseAdminPicture = (key, url) => {
    ensureAdminPictureCacheState();
    state.adminUsers.pictureCache.set(key, { url: url ?? null, fetchedAt: Date.now() });
  };

  const applyCachedPictureToUser = (user) => {
    if (!user || typeof user !== "object") return user;
    const key = normaliseNpubValue(user?.normalizedNpub ?? user?.npub);
    if (!key) return user;
    const cached = resolveFreshAdminPictureCache(key);
    if (cached && cached.url && !user.pictureUrl) {
      return { ...user, pictureUrl: cached.url };
    }
    return user;
  };

  const hydrateAdminPictureCacheFromUsers = (users) => {
    if (!Array.isArray(users)) return;
    const now = Date.now();
    ensureAdminPictureCacheState();
    users.forEach((user) => {
      const key = normaliseNpubValue(user?.normalizedNpub ?? user?.npub);
      if (!key) return;
      if (typeof user?.pictureUrl === "string" && user.pictureUrl.length > 0) {
        state.adminUsers.pictureCache.set(key, { url: user.pictureUrl, fetchedAt: now });
      }
    });
  };

  // ── List management ─────────────────────────────────────────────

  const replaceAdminUsersList = (users) => {
    if (!Array.isArray(users)) return;
    const hydrated = users.map((user) => applyCachedPictureToUser(user));
    hydrateAdminPictureCacheFromUsers(hydrated);
    state.adminUsers.items = hydrated;
    state.adminUsers.initialized = true;
    syncAdminNicknameDrafts(hydrated);
    syncAdminSelectionState(hydrated);
    primeAdminUserPictures(hydrated);
  };

  const upsertAdminUser = (user) => {
    if (!user || typeof user !== "object") return;
    const hydratedUser = applyCachedPictureToUser(user);
    const items = Array.isArray(state.adminUsers.items) ? [...state.adminUsers.items] : [];
    const idx = items.findIndex((entry) => entry.normalizedNpub === user.normalizedNpub);
    if (idx >= 0) {
      items[idx] = hydratedUser;
    } else {
      items.push(hydratedUser);
    }
    items.sort((a, b) => {
      const left = (a?.nickname || a?.alias || a?.npub || "").toLowerCase();
      const right = (b?.nickname || b?.alias || b?.npub || "").toLowerCase();
      if (left === right) {
        return (a?.alias || "").localeCompare(b?.alias || "");
      }
      return left.localeCompare(right);
    });
    state.adminUsers.items = items;
    const key = normaliseNpubValue(user?.normalizedNpub ?? user?.npub);
    if (key && state.adminUsers.nicknameDrafts instanceof Map) {
      const nickname =
        typeof user?.nickname === "string" && user.nickname.trim().length > 0 ? user.nickname : "";
      state.adminUsers.nicknameDrafts.set(key, nickname);
    }
    primeAdminUserPictures(items);
  };

  // ── Picture fetching ────────────────────────────────────────────

  const fetchAdminUserPicture = async (npub) => {
    if (!state.identity.isAdmin || typeof npub !== "string" || npub.length === 0) {
      return;
    }
    ensureAdminPictureRequestState();
    const key = normaliseNpubValue(npub) ?? npub;
    const cached = resolveFreshAdminPictureCache(key);
    if (cached) {
      return;
    }
    if (state.adminUsers.pictureRequests.has(key)) {
      return;
    }
    state.adminUsers.pictureRequests.add(key);
    let resolvedUser = null;
    try {
      const payload = await fetchAdminUserProfile({ npub });
      const users = Array.isArray(payload?.users) ? payload.users : null;
      const user = payload && typeof payload === "object" ? payload.user : null;
      if (Array.isArray(users)) {
        replaceAdminUsersList(users);
        resolvedUser = users.find(
          (entry) => normaliseNpubValue(entry?.normalizedNpub ?? entry?.npub) === normaliseNpubValue(key),
        );
      } else if (user && typeof user === "object") {
        upsertAdminUser(user);
        resolvedUser = user;
      }
      state.adminUsers.error = null;
      memoiseAdminPicture(key, resolvedUser?.pictureUrl ?? null);
    } catch (error) {
      console.warn("[admin] profile lookup failed:", error);
      memoiseAdminPicture(key, null);
    } finally {
      state.adminUsers.pictureRequests.delete(key);
      if (state.adminUsers.pictureRequests.size === 0 && getCurrentRoute() === "settings") {
        render();
      }
    }
  };

  const primeAdminUserPictures = (users) => {
    if (!state.identity.isAdmin) return;
    ensureAdminPictureRequestState();
    ensureAdminPictureCacheState();
    const now = Date.now();
    const list = Array.isArray(users) ? users : state.adminUsers.items;
    if (!Array.isArray(list)) return;
    list.forEach((user) => {
      const key = normaliseNpubValue(user?.normalizedNpub ?? user?.npub);
      if (!key || state.adminUsers.pictureRequests.has(key)) {
        return;
      }
      const cached = resolveFreshAdminPictureCache(key);
      if (cached) {
        if (cached.url && !user.pictureUrl) {
          user.pictureUrl = cached.url;
        }
        return;
      }
      if (typeof user?.pictureUrl === "string" && user.pictureUrl.length > 0) {
        state.adminUsers.pictureCache.set(key, { url: user.pictureUrl, fetchedAt: now });
        return;
      }
      void fetchAdminUserPicture(user.npub);
    });
  };

  // ── CRUD operations ─────────────────────────────────────────────

  const renderIfSettings = () => {
    if (getCurrentRoute() === "settings") {
      render();
    }
  };

  const fetchAdminUsers = async () => {
    if (!state.identity.isAdmin) {
      return;
    }
    state.adminUsers.loading = true;
    try {
      const response = await fetch("/api/admin/users");
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
            ? payload.error
            : response.statusText || "Failed to load users";
        throw new Error(message);
      }
      const users = Array.isArray(payload?.users) ? payload.users : [];
      replaceAdminUsersList(users);
      state.adminUsers.error = null;
      state.adminUsers.pending.clear();
      renderIfSettings();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load users";
      state.adminUsers.error = message;
      renderIfSettings();
    } finally {
      state.adminUsers.loading = false;
      renderIfSettings();
    }
  };

  const toggleUserOnboarding = async (npub, approved) => {
    if (!state.identity.isAdmin || typeof npub !== "string" || npub.length === 0) {
      return;
    }
    const normalizedKey = normaliseNpubValue(npub);
    const key = normalizedKey ?? npub;
    state.adminUsers.pending.add(key);
    renderIfSettings();
    try {
      const response = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ npub, approved }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
            ? payload.error
            : response.statusText || "Failed to update user";
        throw new Error(message);
      }
      const users = Array.isArray(payload?.users) ? payload.users : null;
      const user = payload && typeof payload === "object" ? payload.user : null;
      if (Array.isArray(users)) {
        replaceAdminUsersList(users);
        state.adminUsers.pending.clear();
      } else if (user && typeof user === "object") {
        upsertAdminUser(user);
      }
      state.adminUsers.error = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update user";
      state.adminUsers.error = message;
    } finally {
      state.adminUsers.pending.delete(key);
      renderIfSettings();
    }
  };

  const deleteAdminUser = async (npub, alias) => {
    if (!state.identity.isAdmin || typeof npub !== "string" || npub.length === 0) {
      return;
    }
    const displayName = (typeof alias === "string" && alias.length > 0) ? alias : npub;
    const confirmed = confirm(`Are you sure you want to delete user "${displayName}"? This action cannot be undone and will remove all their data.`);
    if (!confirmed) {
      return;
    }
    const normalizedKey = normaliseNpubValue(npub);
    const key = normalizedKey ?? npub;
    state.adminUsers.pending.add(key);
    renderIfSettings();
    try {
      const response = await fetch("/api/admin/users", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ npub }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
            ? payload.error
            : response.statusText || "Failed to delete user";
        throw new Error(message);
      }
      const users = Array.isArray(payload?.users) ? payload.users : null;
      if (Array.isArray(users)) {
        replaceAdminUsersList(users);
        state.adminUsers.pending.clear();
        clearAdminSelection();
      }
      state.adminUsers.error = null;
      if (normalizedKey) {
        ensureAdminSelectionState().delete(normalizedKey);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to delete user";
      state.adminUsers.error = message;
    } finally {
      state.adminUsers.pending.delete(key);
      renderIfSettings();
    }
  };

  const deleteSelectedAdminUsers = async () => {
    const selectedUsers = getAdminSelectedUsers();
    if (selectedUsers.length === 0) {
      return;
    }
    const keys = selectedUsers
      .map((user) => getAdminUserKey(user))
      .filter((key) => typeof key === "string" && key.length > 0);
    if (keys.length === 0) {
      clearAdminSelection();
      return;
    }
    const identifiers = selectedUsers
      .map((user) => {
        if (!user || typeof user !== "object") return null;
        const nickname = typeof user.nickname === "string" && user.nickname.trim().length > 0 ? user.nickname.trim() : null;
        const alias = typeof user.alias === "string" && user.alias.trim().length > 0 ? user.alias.trim() : null;
        const npub = typeof user.npub === "string" && user.npub.length > 0 ? user.npub : null;
        return nickname ?? alias ?? npub;
      })
      .filter((value) => typeof value === "string" && value.length > 0);
    const displayPreview = identifiers.slice(0, 3).join(", ");
    const displayNames =
      selectedUsers.length === 1 && identifiers.length > 0
        ? `"${identifiers[0]}"`
        : identifiers.length > 0
          ? `${selectedUsers.length} users (${displayPreview}${identifiers.length > 3 ? ", \u2026" : ""})`
          : `${selectedUsers.length} users`;
    const confirmed = confirm(
      `Are you sure you want to delete ${displayNames}? This action cannot be undone and will remove their data.`,
    );
    if (!confirmed) {
      return;
    }
    const pendingKeys = keys.map((key) => key ?? "");
    pendingKeys.forEach((key) => {
      if (!key) return;
      state.adminUsers.pending.add(key);
    });
    state.adminUsers.bulkDeleteBusy = true;
    renderIfSettings();
    try {
      const npubs = selectedUsers
        .map((user) => (typeof user.npub === "string" && user.npub.length > 0 ? user.npub : user.normalizedNpub))
        .filter((value) => typeof value === "string" && value.length > 0);
      if (npubs.length === 0) {
        throw new Error("No valid users selected");
      }
      const response = await fetch("/api/admin/users/bulk", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ npubs }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
            ? payload.error
            : response.statusText || "Failed to delete users";
        throw new Error(message);
      }
      const users = Array.isArray(payload?.users) ? payload.users : null;
      if (Array.isArray(users)) {
        replaceAdminUsersList(users);
        state.adminUsers.pending.clear();
        clearAdminSelection();
      }
      state.adminUsers.error = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to delete users";
      state.adminUsers.error = message;
    } finally {
      pendingKeys.forEach((key) => {
        if (!key) return;
        state.adminUsers.pending.delete(key);
      });
      state.adminUsers.bulkDeleteBusy = false;
      renderIfSettings();
    }
  };

  const updateAdminUserNickname = async (npub, nickname) => {
    if (!state.identity.isAdmin || typeof npub !== "string" || npub.length === 0) {
      return;
    }
    const key = normaliseNpubValue(npub) ?? npub;
    state.adminUsers.pending.add(key);
    renderIfSettings();

    try {
      const response = await fetch("/api/admin/users/nickname", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ npub, nickname }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
            ? payload.error
            : response.statusText || "Failed to update nickname";
        throw new Error(message);
      }
      const users = Array.isArray(payload?.users) ? payload.users : null;
      const user = payload && typeof payload === "object" ? payload.user : null;
      if (Array.isArray(users)) {
        replaceAdminUsersList(users);
        state.adminUsers.pending.clear();
      } else if (user && typeof user === "object") {
        upsertAdminUser(user);
      }
      const resolvedUser =
        user && typeof user === "object"
          ? user
          : Array.isArray(users)
            ? users.find(
                (entry) => normaliseNpubValue(entry?.normalizedNpub ?? entry?.npub) === normaliseNpubValue(key),
              )
            : null;
      if (key && state.adminUsers.nicknameDrafts instanceof Map && resolvedUser) {
        const updatedNickname =
          typeof resolvedUser.nickname === "string" && resolvedUser.nickname.trim().length > 0
            ? resolvedUser.nickname
            : "";
        state.adminUsers.nicknameDrafts.set(key, updatedNickname);
      }
      state.adminUsers.error = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update nickname";
      state.adminUsers.error = message;
    } finally {
      state.adminUsers.pending.delete(key);
      renderIfSettings();
    }
  };

  const addAdminUser = async (npub) => {
    if (!state.identity.isAdmin) {
      return;
    }
    const npubInput = typeof npub === "string" ? npub.trim() : "";
    if (!npubInput) {
      state.adminUsers.addError = "Enter a user npub.";
      renderIfSettings();
      return;
    }

    state.adminUsers.addBusy = true;
    state.adminUsers.addError = null;
    renderIfSettings();

    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ npub: npubInput }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          data && typeof data === "object" && typeof data.error === "string" && data.error.length > 0
            ? data.error
            : response.statusText || "Failed to add user";
        throw new Error(message);
      }
      const users = Array.isArray(data?.users) ? data.users : null;
      const user = data && typeof data === "object" ? data.user : null;
      if (Array.isArray(users)) {
        replaceAdminUsersList(users);
      } else if (user && typeof user === "object") {
        upsertAdminUser(user);
      }
      state.adminUsers.addDraft = "";
      state.adminUsers.addError = null;
    } catch (error) {
      state.adminUsers.addError = error instanceof Error ? error.message : "Failed to add user";
    } finally {
      state.adminUsers.addBusy = false;
      renderIfSettings();
    }
  };

  // ── Ports tool ──────────────────────────────────────────────────

  const ensureAdminPortsToolState = () => {
    if (!state.adminUsers.portsTool) {
      state.adminUsers.portsTool = {
        npub: "",
        count: "3",
        busy: false,
        error: null,
        success: null,
      };
    }
  };

  const submitAdminPortsAssignment = async () => {
    if (!state.identity.isAdmin) {
      return;
    }
    ensureAdminPortsToolState();
    const tool = state.adminUsers.portsTool;
    const npubInput = typeof tool.npub === "string" ? tool.npub.trim() : "";
    const countInput = typeof tool.count === "string" ? tool.count.trim() : "";

    if (!npubInput) {
      tool.error = "Enter a user npub.";
      tool.success = null;
      renderIfSettings();
      return;
    }

    const parsedCount = Number.parseInt(countInput, 10);
    if (!Number.isFinite(parsedCount) || parsedCount < 1 || parsedCount > 100) {
      tool.error = "Enter a port count between 1 and 100.";
      tool.success = null;
      renderIfSettings();
      return;
    }

    const payload = {
      npub: npubInput,
      count: parsedCount,
    };

    tool.busy = true;
    tool.error = null;
    tool.success = null;
    renderIfSettings();

    try {
      const response = await fetch("/api/admin/users/ports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          data && typeof data === "object" && typeof data.error === "string" && data.error.length > 0
            ? data.error
            : response.statusText || "Failed to assign ports";
        throw new Error(message);
      }

      const users = Array.isArray(data?.users) ? data.users : null;
      const user = data && typeof data === "object" ? data.user : null;
      const newPorts = Array.isArray(data?.newPorts) ? data.newPorts : [];

      if (Array.isArray(users)) {
        replaceAdminUsersList(users);
      } else if (user && typeof user === "object") {
        upsertAdminUser(user);
      }

      const portsDisplay = newPorts.length > 0 ? newPorts.join(", ") : "ports";
      tool.success = `Assigned ${parsedCount} new port${parsedCount === 1 ? "" : "s"}: ${portsDisplay}`;
      tool.npub = "";
      tool.count = "3";
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to assign ports";
      tool.error = message;
      tool.success = null;
    } finally {
      tool.busy = false;
      renderIfSettings();
    }
  };

  const generateAdminPorts = async (count = 3) => {
    if (!state.identity.isAdmin) {
      return;
    }

    const parsedCount = Number.isFinite(count) && count > 0 && count <= 100 ? Math.trunc(count) : 3;

    try {
      const response = await fetch("/api/admin/ports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ count: parsedCount }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          data && typeof data === "object" && typeof data.error === "string" && data.error.length > 0
            ? data.error
            : response.statusText || "Failed to generate ports";
        throw new Error(message);
      }

      const users = Array.isArray(data?.users) ? data.users : null;
      const user = data && typeof data === "object" ? data.user : null;
      const newPorts = Array.isArray(data?.newPorts) ? data.newPorts : [];

      if (Array.isArray(users)) {
        replaceAdminUsersList(users);
      } else if (user && typeof user === "object") {
        upsertAdminUser(user);
      }

      if (user && Array.isArray(user.ports)) {
        state.identity.ports = user.ports;
      }

      return { success: true, newPorts };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to generate ports";
      return { success: false, error: message };
    }
  };

  return {
    // Selection
    getAdminUserKey,
    ensureAdminSelectionState,
    setAdminUserSelected,
    clearAdminSelection,
    getAdminSelectedUsers,
    getAdminSelectionCount,
    // CRUD
    fetchAdminUsers,
    replaceAdminUsersList,
    toggleUserOnboarding,
    deleteAdminUser,
    deleteSelectedAdminUsers,
    updateAdminUserNickname,
    addAdminUser,
    // Picture cache
    primeAdminUserPictures,
    // Tools
    ensureAdminPortsToolState,
    submitAdminPortsAssignment,
    generateAdminPorts,
  };
}

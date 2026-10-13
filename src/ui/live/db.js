/**
 * Dexie database for persistent live session data.
 * Stores messages and session state in IndexedDB.
 */

import Dexie from "/vendor/dexie/dexie.mjs";
import { createMessageStore } from "./message-store.js";
import { buildSessionAttentionChanges } from "../sessions/session-attention.js";

// Create database instance
export const db = new Dexie("WingmanLive");

// Define schema
// Version 1: Initial schema with messages and sessions tables
db.version(1).stores({
  messages: "++id, sessionId, [sessionId+createdAt], messageHash",
  sessions: "id, status, updatedAt",
});

// Version 2: Add apiSessions (full session objects from /api/sessions) and apps tables
db.version(2).stores({
  messages: "++id, sessionId, [sessionId+createdAt], messageHash",
  sessions: "id, status, updatedAt",
  apiSessions: "id, status, agentType, npub, updatedAt",
  apps: "id, label, updatedAt",
});

// Version 3: Add targetFile index to apiSessions for writer-mode lookups
db.version(3).stores({
  messages: "++id, sessionId, [sessionId+createdAt], messageHash",
  sessions: "id, status, updatedAt",
  apiSessions: "id, status, agentType, npub, updatedAt, targetFile",
  apps: "id, label, updatedAt",
});

// Version 4: Add ephemeral agent permission requests for native SDK sessions.
db.version(4).stores({
  messages: "++id, sessionId, [sessionId+createdAt], messageHash",
  sessions: "id, status, updatedAt",
  apiSessions: "id, status, agentType, npub, updatedAt, targetFile",
  apps: "id, label, updatedAt",
  permissions: "id, sessionId, status, createdAt, [sessionId+status]",
});

// Version 5: Persist the server-owned prompt queue for reload-safe live display.
db.version(5).stores({
  messages: "++id, sessionId, [sessionId+createdAt], messageHash",
  sessions: "id, status, updatedAt",
  apiSessions: "id, status, agentType, npub, updatedAt, targetFile",
  apps: "id, label, updatedAt",
  permissions: "id, sessionId, status, createdAt, [sessionId+status]",
  promptQueue: "id, sessionId, order, timestamp, [sessionId+order]",
});

// Version 6: index stable transport identities and deterministic transcript order.
db.version(6).stores({
  messages: "++id, sessionId, [sessionId+createdAt], [sessionId+messageId], [sessionId+order], messageHash",
  sessions: "id, status, updatedAt",
  apiSessions: "id, status, agentType, npub, updatedAt, targetFile",
  apps: "id, label, updatedAt",
  permissions: "id, sessionId, status, createdAt, [sessionId+status]",
  promptQueue: "id, sessionId, order, timestamp, [sessionId+order]",
});

// Version 7: discard message rows produced by the pre-v7 optimistic-message
// reconciliation bug. Messages are a server-derived cache and rehydrate on
// load; session state, queues, and other browser-owned data remain intact.
db.version(7).stores({
  messages: "++id, sessionId, [sessionId+createdAt], [sessionId+messageId], [sessionId+order], messageHash",
  sessions: "id, status, updatedAt",
  apiSessions: "id, status, agentType, npub, updatedAt, targetFile",
  apps: "id, label, updatedAt",
  permissions: "id, sessionId, status, createdAt, [sessionId+status]",
  promptQueue: "id, sessionId, order, timestamp, [sessionId+order]",
}).upgrade((transaction) => transaction.table("messages").clear());

// Version 8: clear live-turn duplicates created after the v7 migration but
// before optimistic origin was retained through all transport echoes.
db.version(8).stores({
  messages: "++id, sessionId, [sessionId+createdAt], [sessionId+messageId], [sessionId+order], messageHash",
  sessions: "id, status, updatedAt",
  apiSessions: "id, status, agentType, npub, updatedAt, targetFile",
  apps: "id, label, updatedAt",
  permissions: "id, sessionId, status, createdAt, [sessionId+status]",
  promptQueue: "id, sessionId, order, timestamp, [sessionId+order]",
}).upgrade((transaction) => transaction.table("messages").clear());

// Version 9: persist viewer-specific session attention separately from the
// server-owned session cache. This lets completed turns remain highlighted
// across reloads until the viewer opens the session.
db.version(9).stores({
  messages: "++id, sessionId, [sessionId+createdAt], [sessionId+messageId], [sessionId+order], messageHash",
  sessions: "id, status, updatedAt",
  apiSessions: "id, status, agentType, npub, updatedAt, targetFile",
  apps: "id, label, updatedAt",
  permissions: "id, sessionId, status, createdAt, [sessionId+status]",
  promptQueue: "id, sessionId, order, timestamp, [sessionId+order]",
  sessionAttention: "sessionId, runtimeStatus, lastRunningAt, completedAt, viewedAt",
});

// Version 10: persist browser-specific UI preferences without relying on
// memory-only state or localStorage.
db.version(10).stores({
  messages: "++id, sessionId, [sessionId+createdAt], [sessionId+messageId], [sessionId+order], messageHash",
  sessions: "id, status, updatedAt",
  apiSessions: "id, status, agentType, npub, updatedAt, targetFile",
  apps: "id, label, updatedAt",
  permissions: "id, sessionId, status, createdAt, [sessionId+status]",
  promptQueue: "id, sessionId, order, timestamp, [sessionId+order]",
  sessionAttention: "sessionId, runtimeStatus, lastRunningAt, completedAt, viewedAt",
  uiPreferences: "key",
});

// Version 11: durable archived history, keyed by the requested session.
db.version(11).stores({ sessionHistory: "sessionId,syncedAt" });

/**
 * Message store operations.
 *
 * Messages are identified by session + position index (messageIdx).
 * Streaming updates grow the content of the last message in-place
 * rather than inserting duplicates.
 */
export const MessageStore = createMessageStore(db);

export const PermissionStore = {
  async getSessionPermissions(sessionId) {
    return db.permissions
      .where("[sessionId+status]")
      .equals([sessionId, "pending"])
      .sortBy("createdAt");
  },

  async upsert(sessionId, permission) {
    if (!permission?.id) return;
    await db.permissions.put({
      ...permission,
      id: `${sessionId}:${permission.id}`,
      permissionId: permission.id,
      sessionId,
      status: "pending",
      responding: false,
      updatedAt: new Date().toISOString(),
    });
  },

  async replaceSession(sessionId, permissions) {
    await this.clearSession(sessionId);
    for (const permission of Array.isArray(permissions) ? permissions : []) {
      await this.upsert(sessionId, permission);
    }
  },

  async remove(sessionId, permissionId) {
    await db.permissions.delete(`${sessionId}:${permissionId}`);
  },

  async setResponding(sessionId, permissionId, responding) {
    await db.permissions.update(`${sessionId}:${permissionId}`, {
      responding: Boolean(responding),
      updatedAt: new Date().toISOString(),
    });
  },

  liveQuery(sessionId) {
    return db.permissions
      .where("[sessionId+status]")
      .equals([sessionId, "pending"])
      .sortBy("createdAt");
  },

  async clearSession(sessionId) {
    await db.permissions.where("sessionId").equals(sessionId).delete();
  },
};

export const PromptQueueStore = {
  async getSessionPrompts(sessionId) {
    return db.promptQueue.where("sessionId").equals(sessionId).sortBy("order");
  },

  async upsert(sessionId, prompt) {
    if (!prompt?.id) return;
    await db.promptQueue.put({
      ...prompt,
      sessionId,
      updatedAt: new Date().toISOString(),
    });
  },

  async replaceSession(sessionId, prompts, handled) {
    await db.transaction("rw", db.promptQueue, async () => {
      const existing = handled === undefined
        ? (await db.promptQueue.where("sessionId").equals(sessionId).toArray()).filter((prompt) => prompt.state === "handled")
        : handled;
      await db.promptQueue.where("sessionId").equals(sessionId).delete();
      const records = [...(Array.isArray(prompts) ? prompts : []), ...(Array.isArray(existing) ? existing : [])]
        .filter((prompt) => prompt?.id)
        .map((prompt) => ({ ...prompt, sessionId, updatedAt: new Date().toISOString() }));
      if (records.length > 0) await db.promptQueue.bulkPut(records);
    });
  },

  async remove(sessionId, promptId) {
    const prompt = await db.promptQueue.get(promptId);
    if (prompt?.sessionId === sessionId) await db.promptQueue.delete(promptId);
  },

  async updateContent(sessionId, promptId, content) {
    const prompt = await db.promptQueue.get(promptId);
    if (prompt?.sessionId !== sessionId) return;
    await db.promptQueue.update(promptId, { content, updatedAt: new Date().toISOString() });
  },

  async clearSession(sessionId) {
    await db.promptQueue.where("sessionId").equals(sessionId).delete();
  },
};

/**
 * Session store operations.
 */
export const SessionStore = {
  /**
   * Update session status.
   */
  async updateStatus(sessionId, status, agentRuntimeStatus = null) {
    return db.sessions.put({
      id: sessionId,
      status,
      agentRuntimeStatus: agentRuntimeStatus || status,
      updatedAt: new Date().toISOString(),
    });
  },

  /**
   * Patch a cached session status record in-place.
   */
  async patchSession(sessionId, updates) {
    if (!sessionId || !updates || typeof updates !== "object") {
      return null;
    }

    const existing = await db.sessions.get(sessionId);
    const next = {
      ...(existing ?? { id: sessionId }),
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    await db.sessions.put(next);
    return next;
  },

  /**
   * Get session status.
   */
  async getSession(sessionId) {
    return db.sessions.get(sessionId);
  },

  /**
   * Subscribe to a single session status record.
   */
  liveQuery(sessionId) {
    return () => this.getSession(sessionId);
  },

  /**
   * Check if session is busy (running).
   */
  async isBusy(sessionId) {
    const session = await this.getSession(sessionId);
    return session?.agentRuntimeStatus === "running" || session?.status === "running";
  },

  /**
   * Clear session status.
   */
  async clearSession(sessionId) {
    return db.sessions.delete(sessionId);
  },
};

/**
 * API session store operations.
 * Caches full session objects from /api/sessions for instant page loads.
 */
export const ApiSessionStore = {
  /** Get all cached API sessions. */
  async getAll() {
    return db.apiSessions.toArray();
  },

  /** Bulk upsert sessions from API response. Replaces cache with server truth. */
  async upsertMany(sessions) {
    if (!Array.isArray(sessions)) return;
    await db.transaction("rw", db.apiSessions, async () => {
      await db.apiSessions.clear();
      if (sessions.length > 0) {
        await db.apiSessions.bulkPut(
          sessions.map((s) => ({ ...s, updatedAt: new Date().toISOString() })),
        );
      }
    });
  },

  /** Get a single session by id. */
  async getById(id) {
    return db.apiSessions.get(id);
  },

  /**
   * Patch a cached API session in-place without replacing the full table.
   */
  async patchSession(id, updates) {
    if (!id || !updates || typeof updates !== "object") {
      return null;
    }

    const existing = await db.apiSessions.get(id);
    if (!existing) {
      return null;
    }

    const next = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    await db.apiSessions.put(next);
    return next;
  },

  /** Remove a single session by id. */
  async remove(id) {
    return db.apiSessions.delete(id);
  },

  /** Clear all cached sessions. */
  async clear() {
    return db.apiSessions.clear();
  },
};

export const SessionAttentionStore = {
  async getAll() {
    return db.sessionAttention.toArray();
  },

  async reconcile(sessions, now = new Date().toISOString()) {
    if (!Array.isArray(sessions)) return;

    return await db.transaction("rw", db.sessionAttention, async () => {
      const existingRecords = await db.sessionAttention.toArray();
      const { updates, completedSessionIds } = buildSessionAttentionChanges(
        sessions,
        existingRecords,
        now,
      );

      if (updates.length > 0) {
        await db.sessionAttention.bulkPut(updates);
      }
      return completedSessionIds;
    });
  },

  async markViewed(sessionId, now = new Date().toISOString()) {
    if (typeof sessionId !== "string" || sessionId.length === 0) return null;
    const existing = await db.sessionAttention.get(sessionId);
    const next = { ...(existing ?? { sessionId }), viewedAt: now };
    await db.sessionAttention.put(next);
    return next;
  },

  async clear() {
    return db.sessionAttention.clear();
  },
};

export const UiPreferenceStore = {
  async get(key) {
    if (typeof key !== "string" || key.length === 0) return null;
    return (await db.uiPreferences.get(key)) ?? null;
  },

  async set(key, value) {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("UI preference key is required");
    }
    const record = { key, value, updatedAt: new Date().toISOString() };
    await db.uiPreferences.put(record);
    return record;
  },
};

/**
 * Apps table operations.
 * Caches full app objects from /api/apps for instant page loads.
 */
export const AppsTable = {
  /** Get all cached apps. */
  async getAll() {
    return db.apps.toArray();
  },

  /** Bulk upsert apps from API response. Replaces cache with server truth. */
  async upsertMany(apps) {
    if (!Array.isArray(apps)) return;
    await db.transaction("rw", db.apps, async () => {
      await db.apps.clear();
      if (apps.length > 0) {
        await db.apps.bulkPut(
          apps.map((a) => ({ ...a, updatedAt: new Date().toISOString() })),
        );
      }
    });
  },

  /** Get a single app by id. */
  async getById(id) {
    return db.apps.get(id);
  },

  /** Remove a single app by id. */
  async remove(id) {
    return db.apps.delete(id);
  },

  /** Clear all cached apps. */
  async clear() {
    return db.apps.clear();
  },
};

/**
 * Database utilities.
 */
export const DbUtils = {
  /**
   * Clear all data from the database.
   */
  async clearAll() {
    await db.messages.clear();
    await db.sessions.clear();
    await db.apiSessions.clear();
    await db.apps.clear();
    await db.permissions.clear();
    await db.promptQueue.clear();
  },

  /**
   * Get database statistics.
   */
  async getStats() {
    const [messageCount, sessionCount, apiSessionCount, appCount, permissionCount, promptQueueCount] = await Promise.all([
      db.messages.count(),
      db.sessions.count(),
      db.apiSessions.count(),
      db.apps.count(),
      db.permissions.count(),
      db.promptQueue.count(),
    ]);
    return { messageCount, sessionCount, apiSessionCount, appCount, permissionCount, promptQueueCount };
  },

  /**
   * Export all data (for debugging).
   */
  async exportAll() {
    const [messages, sessions, apiSessions, apps, permissions, promptQueue] = await Promise.all([
      db.messages.toArray(),
      db.sessions.toArray(),
      db.apiSessions.toArray(),
      db.apps.toArray(),
      db.permissions.toArray(),
      db.promptQueue.toArray(),
    ]);
    return { messages, sessions, apiSessions, apps, permissions, promptQueue };
  },
};

// Re-export Dexie for liveQuery usage
export { Dexie };

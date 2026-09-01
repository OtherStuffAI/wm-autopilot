/**
 * Dexie database for persistent live session data.
 * Stores messages and session state in IndexedDB.
 */

import Dexie from "/vendor/dexie/dexie.mjs";
import {
  areConversationMessagesEqual,
  hasEquivalentIncomingUser,
  isUserMessageCoveredBySnapshot,
  normalizeConversationMessage,
  normalizeConversationMessages,
} from "./conversation-sync.js";
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

/**
 * Message store operations.
 *
 * Messages are identified by session + position index (messageIdx).
 * Streaming updates grow the content of the last message in-place
 * rather than inserting duplicates.
 */
export const MessageStore = {
  /**
   * Upsert a single SSE message.
   * For streaming, the server re-sends the last message with growing content.
   * We find the last message for this session+role and update it in-place
   * when the new content is a longer version of the existing content.
   */
  async upsertMessage(sessionId, message) {
    const normalized = normalizeConversationMessage(message);
    const role = normalized.role;
    const content = normalized.content;
    const createdAt = normalized.createdAt;
    const messageId = normalized.messageId ?? null;
    const turnId = normalized.turnId ?? null;
    const order = normalized.order ?? null;
    const now = new Date().toISOString();

    const sessionMessages = await db.messages.where("sessionId").equals(sessionId).toArray();
    const matchingMessageById = messageId
      ? sessionMessages.find((entry) => entry.messageId === messageId)
      : null;
    const matchingTimestampMessages = createdAt
      ? sessionMessages.filter((entry) => entry.createdAt === createdAt)
      : [];
    const optimisticUserMessage = role === "user"
      ? sessionMessages.find((entry) => entry.optimistic === true && entry.content === content)
      : null;
    const matchingMessage = matchingMessageById ?? optimisticUserMessage ?? (!messageId
      ? [...matchingTimestampMessages].reverse().find((entry) => entry.role === role)
      : null);

    if (matchingMessage) {
      const speech = normalized.speech ?? matchingMessage.speech ?? null;
      await db.messages.update(matchingMessage.id, {
        content,
        createdAt,
        messageId: messageId ?? matchingMessage.messageId ?? null,
        turnId: turnId ?? matchingMessage.turnId ?? null,
        order: order ?? matchingMessage.order ?? null,
        speech,
        pending: false,
        updatedAt: now,
      });
      return { id: matchingMessage.id, isStreamingUpdate: true };
    }

    // Find the last message for this session
    const existing = await db.messages
      .where("sessionId").equals(sessionId)
      .last();

    // Streaming update: same role and new content extends the old content
    if (!messageId && existing && existing.role === role) {
      const oldContent = existing.content || "";
      if (content.length > oldContent.length && content.startsWith(oldContent.slice(0, 50))) {
        const speech = normalized.speech ?? existing.speech ?? null;
        await db.messages.update(existing.id, {
          content,
          messageId: messageId ?? existing.messageId ?? null,
          speech,
          updatedAt: now,
        });
        return { id: existing.id, isStreamingUpdate: true };
      }
    }

    // New message
    const id = await db.messages.add({
      sessionId,
      role,
      content,
      messageId,
      turnId,
      order,
      speech: normalized.speech ?? null,
      createdAt,
      updatedAt: now,
      messageHash: `${sessionId}:${role}:${Date.now()}`,
    });
    return { id, isStreamingUpdate: false };
  },

  async addPendingUserMessage(sessionId, content) {
    const createdAt = new Date().toISOString();
    return db.messages.add({
      sessionId,
      role: "user",
      content,
      messageId: `pending-${crypto.randomUUID()}`,
      turnId: null,
      order: null,
      speech: null,
      pending: true,
      optimistic: true,
      createdAt,
      updatedAt: createdAt,
      messageHash: `${sessionId}:pending:${createdAt}`,
    });
  },

  async removePendingMessage(sessionId, id) {
    const message = await db.messages.get(id);
    if (message?.sessionId === sessionId && message.pending === true) {
      await db.messages.delete(id);
    }
  },

  /**
   * Get all messages for a session, ordered by createdAt.
   */
  async getSessionMessages(sessionId) {
    const messages = await db.messages.where("sessionId").equals(sessionId).toArray();
    return messages.sort((left, right) => {
      const leftOrder = typeof left.order === "number" ? left.order : Number.MAX_SAFE_INTEGER;
      const rightOrder = typeof right.order === "number" ? right.order : Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || String(left.createdAt).localeCompare(String(right.createdAt)) || left.id - right.id;
    });
  },

  async updateMessageSpeech(sessionId, message, speech) {
    if (!speech?.publicPath) return false;
    const normalized = normalizeConversationMessage(message);
    const existing = await this.getSessionMessages(sessionId);
    const match = existing.find((entry) => {
      if (normalized.messageId && entry.messageId === normalized.messageId) {
        return true;
      }
      return (
        entry.role === normalized.role &&
        entry.createdAt === normalized.createdAt &&
        entry.content === normalized.content
      );
    });
    if (!match?.id) return false;
    await db.messages.update(match.id, {
      messageId: normalized.messageId ?? match.messageId ?? null,
      speech,
      updatedAt: new Date().toISOString(),
    });
    return true;
  },

  /**
   * Get message count for a session.
   */
  async getMessageCount(sessionId) {
    return db.messages.where("sessionId").equals(sessionId).count();
  },

  /**
   * Clear all messages for a session.
   */
  async clearSession(sessionId) {
    return db.messages.where("sessionId").equals(sessionId).delete();
  },

  /**
   * Sync full conversation from server (initial load or refresh).
   * Updates existing messages in-place (preserving Dexie IDs so Alpine
   * `:key` stays stable) and only adds/removes rows when the count changes.
   */
  async syncFromServer(sessionId, messages) {
    if (!Array.isArray(messages)) return;

    await db.transaction("rw", db.messages, async () => {
      const existing = await this.getSessionMessages(sessionId);

      const now = new Date().toISOString();
      const incoming = normalizeConversationMessages(messages, now);

      const updates = [];
      const existingByIdentity = new Map(existing.filter((message) => message.messageId).map((message) => [message.messageId, message]));
      const matchedIds = new Set();
      for (let i = 0; i < incoming.length; i++) {
        const inc = incoming[i];
        const optimisticUserMessage = inc.role === "user"
          ? existing.find((message) => message.optimistic === true && message.content === inc.content && !matchedIds.has(message.id))
          : null;
        const matchingLegacyMessage = !inc.messageId
          ? existing.find((message) =>
              message.pending !== true &&
              message.role === inc.role &&
              message.content === inc.content &&
              message.createdAt === inc.createdAt &&
              !matchedIds.has(message.id)
            )
          : null;
        const positionalMessage = existing[i];
        // ACP snapshots can expose agent-working output before the matching
        // user echo. Never let that new, identified transport row consume the
        // optimistic user row merely because it currently occupies the same
        // array position. Identified rows must reconcile by identity (or by the
        // exact optimistic user echo); positional matching is only a legacy
        // fallback for transports that do not provide message ids.
        const positionalFallback =
          !inc.messageId &&
          positionalMessage?.pending !== true &&
          positionalMessage?.role === inc.role
            ? positionalMessage
            : null;
        const old = (inc.messageId ? existingByIdentity.get(inc.messageId) : null)
          ?? optimisticUserMessage
          ?? matchingLegacyMessage
          ?? positionalFallback;
        if (!old) {
          updates.push(db.messages.add({ sessionId, ...inc, messageId: inc.messageId ?? null,
            turnId: inc.turnId ?? null, order: inc.order ?? null, speech: inc.speech ?? null,
            updatedAt: now, messageHash: `${sessionId}:${inc.messageId ?? i}:${now}` }));
          continue;
        }
        matchedIds.add(old.id);
        if (
          old.content === inc.content &&
          old.role === inc.role &&
          (old.messageId ?? null) === (inc.messageId ?? null) &&
          (old.turnId ?? null) === (inc.turnId ?? null) &&
          (old.order ?? null) === (inc.order ?? null) &&
          old.pending !== true &&
          old.optimistic !== true &&
          JSON.stringify(old.speech ?? null) === JSON.stringify(inc.speech ?? null)
        ) {
          continue;
        }
        // Don't let a momentarily-stale server snapshot shrink a bubble that the
        // SSE stream has already grown further. A streamed assistant turn only
        // ever grows, so when the incoming content is a prefix of what we already
        // have for the same role, keep the longer local copy.
        const isStreamingShrink =
          old.role === inc.role &&
          inc.content.length < (old.content || "").length &&
          (old.content || "").startsWith(inc.content);
        if (isStreamingShrink) {
          continue;
        }
        updates.push(
          db.messages.update(old.id, {
            content: inc.content,
            role: inc.role,
            createdAt: inc.createdAt,
            messageId: inc.messageId ?? old.messageId ?? null,
            turnId: inc.turnId ?? old.turnId ?? null,
            order: inc.order ?? old.order ?? null,
            speech: inc.speech ?? old.speech ?? null,
            pending: false,
            optimistic: false,
            updatedAt: now,
          }),
        );
      }

      const idsToDelete = existing
        // Live agent transcripts are monotonic for user input. A native
        // transport can echo an optimistic prompt and then briefly return an
        // older full snapshot that does not contain that turn yet. Once a user
        // row has been visible, never let that stale snapshot remove it; a
        // later canonical echo will continue reconciling it by message id or
        // exact content. Non-user rows remain server-authoritative so obsolete
        // streamed output can still be removed.
        .filter((message) => {
          if (matchedIds.has(message.id)) return false;
          if (message.role !== "user") return true;
          // Preserve a newly-sent prompt while the server snapshot catches up.
          // Once the canonical timeline has advanced past an unmatched row,
          // remove that stale transport echo instead of rendering it forever.
          return hasEquivalentIncomingUser(message, incoming) ||
            isUserMessageCoveredBySnapshot(message, incoming);
        })
        .map((message) => message.id);
      if (idsToDelete.length) updates.push(db.messages.bulkDelete(idsToDelete));

      await Promise.all(updates);
    });
  },

  /**
   * Sync a full conversation only when the canonical message rows changed.
   * Returns the canonical messages plus a changed flag so callers can skip
   * redundant DOM work after no-op refreshes.
   */
  async syncFromServerIfChanged(sessionId, messages) {
    const normalized = normalizeConversationMessages(messages);
    const existing = await this.getSessionMessages(sessionId);
    const comparable = normalized.map((message, index) => {
      const local = existing[index];
      const sameMessage =
        local &&
        local.role === message.role &&
        local.content === message.content &&
        (local.messageId ?? null) === (message.messageId ?? local.messageId ?? null);
      if (!message.speech && sameMessage && local.speech) {
        return { ...message, speech: local.speech };
      }
      return message;
    });

    if (areConversationMessagesEqual(existing, comparable)) {
      return {
        changed: false,
        messages: existing,
      };
    }

    await this.syncFromServer(sessionId, normalized);
    return {
      changed: true,
      messages: normalized,
    };
  },

  /**
   * Subscribe to message changes for a session.
   * Returns a function for Dexie's liveQuery.
   */
  liveQuery(sessionId) {
    return () => this.getSessionMessages(sessionId);
  },
};

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

  async replaceSession(sessionId, prompts) {
    await db.transaction("rw", db.promptQueue, async () => {
      await db.promptQueue.where("sessionId").equals(sessionId).delete();
      const records = (Array.isArray(prompts) ? prompts : [])
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

  async reconcile(sessions, viewedSessionId = null, now = new Date().toISOString()) {
    if (!Array.isArray(sessions)) return;

    await db.transaction("rw", db.sessionAttention, async () => {
      const existingRecords = await db.sessionAttention.toArray();
      const { updates } = buildSessionAttentionChanges(
        sessions,
        existingRecords,
        viewedSessionId,
        now,
      );

      if (updates.length > 0) {
        await db.sessionAttention.bulkPut(updates);
      }
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
    if (!Array.isArray(apps) || apps.length === 0) return;
    await db.transaction("rw", db.apps, async () => {
      await db.apps.clear();
      await db.apps.bulkPut(
        apps.map((a) => ({ ...a, updatedAt: new Date().toISOString() })),
      );
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

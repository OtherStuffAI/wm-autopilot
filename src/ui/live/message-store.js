import { randomId } from "../core/random-id.js";
import { normalizeConversationMessage, normalizeConversationMessages } from "./conversation-sync.js";
import { messageWrite, readMessageRevision, writeMessageRevision } from "./message-revisions.js";
import { createReconciliationIndex } from "./message-reconciliation-index.js";

export function createMessageStore(db) {
  return {
    async getRevision(sessionId) {
      return readMessageRevision(db, sessionId);
    },

    async upsertMessage(sessionId, message) {
      return messageWrite(db, sessionId, () => this._upsertMessage(sessionId, message));
    },

    async _upsertMessage(sessionId, message) {
      const normalized = normalizeConversationMessage(message);
      const role = normalized.role;
      const content = normalized.content;
      const createdAt = normalized.createdAt;
      const messageId = normalized.messageId ?? null;
      const turnId = normalized.turnId ?? null;
      const order = normalized.order ?? null;
      const now = new Date().toISOString();

      const matchingMessageById = messageId
        ? await db.messages.where("[sessionId+messageId]").equals([sessionId, messageId]).first()
        : null;
      const matchingTimestampMessages = !messageId && createdAt
        ? await db.messages.where("[sessionId+createdAt]").equals([sessionId, createdAt]).toArray()
        : [];
      const optimisticUserMessage = role === "user" && !matchingMessageById
        ? await db.messages.where("sessionId").equals(sessionId)
          .filter((entry) => entry.optimistic === true && entry.content === content).first()
        : null;
      const matchingMessage = matchingMessageById ?? optimisticUserMessage ?? (!messageId
        ? [...matchingTimestampMessages].reverse().find((entry) => entry.role === role)
        : null);

      if (matchingMessage) {
        const speech = normalized.speech ?? matchingMessage.speech ?? null;
        await db.messages.update(matchingMessage.id, {
          content,
          role,
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
      return messageWrite(db, sessionId, () => db.messages.add({
        sessionId,
        role: "user",
        content,
        messageId: `pending-${randomId()}`,
        turnId: null,
        order: null,
        speech: null,
        pending: true,
        optimistic: true,
        createdAt,
        updatedAt: createdAt,
        messageHash: `${sessionId}:pending:${createdAt}`,
      }));
    },

    async removePendingMessage(sessionId, id) {
      const message = await db.messages.get(id);
      if (message?.sessionId === sessionId && message.pending === true) {
        await messageWrite(db, sessionId, () => db.messages.delete(id));
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
      await messageWrite(db, sessionId, () => db.messages.update(match.id, {
        messageId: normalized.messageId ?? match.messageId ?? null,
        speech,
        updatedAt: new Date().toISOString(),
      }));
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
      return messageWrite(db, sessionId, () => db.messages.where("sessionId").equals(sessionId).delete());
    },

    /**
     * Sync full conversation from server (initial load or refresh).
     * Updates existing messages in-place (preserving Dexie IDs so Alpine
     * `:key` stays stable) and only adds/removes rows when the count changes.
     */
    async syncFromServer(sessionId, messages, options = {}) {
      if (!Array.isArray(messages)) return;

      return db.transaction("rw", db.messages, db.uiPreferences, async () => {
        if (options.signal?.aborted || (options.expectedRevision !== undefined &&
            await readMessageRevision(db, sessionId) !== options.expectedRevision)) return { changed: false, stale: true };
        const existing = await this.getSessionMessages(sessionId);

        if (options.signal?.aborted) return { changed: false, stale: true };
        const now = new Date().toISOString();
        const incoming = normalizeConversationMessages(messages, now);

        const updates = [];
        const additions = [];
        const index = createReconciliationIndex(existing, incoming);
        const existingByIdentity = new Map(existing.filter((message) => message.messageId).map((message) => [message.messageId, message]));
        const matchedIds = new Set();
        for (let i = 0; i < incoming.length; i++) {
          const inc = incoming[i];
          const optimisticUserMessage = inc.role === "user" ? index.optimistic(inc.content, matchedIds) : null;
          const matchingLegacyMessage = !inc.messageId ? index.legacy(inc, matchedIds) : null;
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
            additions.push({ sessionId, ...inc, messageId: inc.messageId ?? null,
              turnId: inc.turnId ?? null, order: inc.order ?? null, speech: inc.speech ?? null,
              updatedAt: now, messageHash: `${sessionId}:${inc.messageId ?? i}:${now}` });
            continue;
          }
          matchedIds.add(old.id);
          if (
            old.content === inc.content &&
            old.role === inc.role &&
            old.createdAt === inc.createdAt &&
            (old.messageId ?? null) === (inc.messageId ?? null) &&
            (old.turnId ?? null) === (inc.turnId ?? null) &&
            (old.order ?? null) === (inc.order ?? null) &&
            old.pending !== true &&
            old.optimistic !== true &&
            JSON.stringify(old.speech ?? null) === JSON.stringify(inc.speech ?? old.speech ?? null)
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
            { ...old,
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
            },
          );
        }

        const idsToDelete = existing
          // Live agent transcripts are monotonic for user input. A native
          // transport can echo an optimistic prompt and then briefly return an
          // older full snapshot that does not contain that turn yet. Once a user
          // row has been visible, never let that stale snapshot remove it; a
          // later canonical echo will continue reconciling it by message id or
          // exact content. Remove obsolete non-user rows only when the snapshot
          // watermark covers them; retain newer browser-saved stream output.
          .filter((message) => {
            if (matchedIds.has(message.id)) return false;
            if (message.role !== "user") return index.snapshotCovers(message);
            // Preserve a newly-sent prompt while the server snapshot catches up.
            // Once the canonical timeline has advanced past an unmatched row,
            // remove that stale transport echo instead of rendering it forever.
            return index.userCovered(message);
          })
          .map((message) => message.id);
        if (!updates.length && !additions.length && !idsToDelete.length) return { changed: false };
        if (updates.length) await db.messages.bulkPut(updates);
        if (additions.length) await db.messages.bulkAdd(additions);
        if (idsToDelete.length) await db.messages.bulkDelete(idsToDelete);
        await writeMessageRevision(db, sessionId);
        return { changed: true };
      });
    },

    /**
     * Sync a full conversation only when the canonical message rows changed.
     * Returns a changed flag so callers can skip redundant DOM work after
     * no-op refreshes. UI consumers read the committed rows through Dexie.
     */
    async syncFromServerIfChanged(sessionId, messages, options = {}) {
      return this.syncFromServer(sessionId, messages, options);
    },

    /**
     * Subscribe to message changes for a session.
     * Returns a function for Dexie's liveQuery.
     */
    liveQuery(sessionId) {
      return () => this.getSessionMessages(sessionId);
    },
  };
}

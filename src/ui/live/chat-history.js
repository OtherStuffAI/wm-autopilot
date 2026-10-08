import { sessionHistorySync } from "./session-history-sync.js";

export function createChatHistoryMethods() {
  return {
    isRefreshing: false,
    historyLoaded: false,
    refreshError: null,
    _historyGeneration: 0,

    _cancelHistory() {
      this._historyGeneration += 1;
      if (this.sessionId) sessionHistorySync.cancel(this.sessionId);
      this.historyLoaded = false;
      this.isRefreshing = false;
      this.refreshError = null;
    },

    async _syncMessagesFromServer(sessionId) {
      const generation = this._historyGeneration;
      const active = () => this.sessionId === sessionId && this._historyGeneration === generation;
      this.isRefreshing = true;
      try {
        // Durable server history never waits for the agent or stream setup.
        await sessionHistorySync.sync(sessionId);
        if (!active()) return;
        this.historyLoaded = true;
        this.isLoading = false;
      } catch (error) {
        if (!active()) return;
        this.error = error.message;
        this.isLoading = false;
      }
      if (!active()) return;
      await this._refreshCurrentHistory(sessionId, generation);
    },

    async _refreshCurrentHistory(sessionId = this.sessionId, generation = this._historyGeneration) {
      if (!sessionId) return;
      const active = () => this.sessionId === sessionId && this._historyGeneration === generation;
      this.isRefreshing = true;
      this.refreshError = null;
      try {
        await sessionHistorySync.sync(sessionId, { refresh: true });
        if (!active()) return;
        this.historyLoaded = true;
        this.error = null;
        this.isLoading = false;
      } catch (error) {
        if (!active()) return;
        this.refreshError = error.message;
      } finally {
        if (active()) this.isRefreshing = false;
      }
    },

    retryHistory() {
      return this._syncMessagesFromServer(this.sessionId);
    },
  };
}

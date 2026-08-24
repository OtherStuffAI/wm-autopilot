type SessionMessageUpdateListener = () => void;

export class SessionMessageUpdates {
  private readonly listeners = new Map<string, Set<SessionMessageUpdateListener>>();

  publish(sessionId: string): void {
    for (const listener of this.listeners.get(sessionId) ?? []) {
      try {
        listener();
      } catch {
        // A closed browser stream must not fail persistence or other listeners.
      }
    }
  }

  subscribe(sessionId: string, listener: SessionMessageUpdateListener): () => void {
    const sessionListeners = this.listeners.get(sessionId) ?? new Set();
    sessionListeners.add(listener);
    this.listeners.set(sessionId, sessionListeners);
    return () => {
      sessionListeners.delete(listener);
      if (sessionListeners.size === 0) this.listeners.delete(sessionId);
    };
  }
}

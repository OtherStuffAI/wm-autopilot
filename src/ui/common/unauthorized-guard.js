const DEFAULT_COOLDOWN_MS = 2000;

export const createUnauthorizedGuard = ({ onLogout, cooldownMs = DEFAULT_COOLDOWN_MS } = {}) => {
  let lastTriggeredAt = 0;

  return () => {
    const now = Date.now();
    if (now - lastTriggeredAt < cooldownMs) {
      return;
    }
    lastTriggeredAt = now;
    try {
      onLogout?.();
    } catch (error) {
      console.error("[auth] failed to handle unauthorized state", error);
    }
  };
};

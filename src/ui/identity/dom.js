/**
 * Identity DOM helpers — button state, display sync, countdown, persistence.
 *
 * Pure utility functions are top-level exports. Stateful functions that need
 * access to `state` and `requestAuthUiSync` are returned from initIdentityDom().
 */

// ── Pure utility exports (no DI needed) ─────────────────────────────

export const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);

export const toFiniteTimestamp = (value) => {
  if (isFiniteNumber(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.getTime();
  }
  return null;
};

export const abbreviateNpub = (npub) => {
  if (!npub || typeof npub !== "string") return "";
  const trimmed = npub.trim();
  if (trimmed.length <= 20) return trimmed;
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-6)}`;
};

export const formatSatoshis = (value) => {
  const satoshis = isFiniteNumber(value) ? Math.max(0, Math.trunc(value)) : 0;
  const formatted = satoshis.toLocaleString();
  return `${formatted} ${satoshis === 1 ? "sat" : "sats"}`;
};

export const normaliseNpubValue = (npub) => {
  if (typeof npub !== "string") return null;
  const trimmed = npub.trim();
  return trimmed.length === 0 ? null : trimmed;
};

export const identityMethodLabels = {
  none: "Not signed in",
  nip07: "Browser extension",
  local_keys: "BYO Nsec",
  bunker: "Remote signer",
};

// ── Init (stateful functions that close over state + requestAuthUiSync) ──

export function initIdentityDom(deps) {
  const { state, requestAuthUiSync } = deps;

  // ── constants ───────────────────────────────────────────────────

  const IDENTITY_STORAGE_KEY = "wingman-identity-state";
  const IDENTITY_EVENT_NAMES = ["wingman:identity-state", "identity:state", "nostr-auth:state"];

  // ── shared data structures ──────────────────────────────────────

  const identityDomEntries = new Set();
  const identityDomEntryByNode = new WeakMap();
  const identityCopyFeedbackTimeouts = new WeakMap();
  const identityButtonTimers = new WeakMap();
  let identityCountdownIntervalId = null;

  // ── button state helpers ────────────────────────────────────────

  function clearButtonStateTimer(button) {
    if (!button) return;
    const timerId = identityButtonTimers.get(button);
    if (timerId) {
      window.clearTimeout(timerId);
      identityButtonTimers.delete(button);
    }
  }

  function ensureButtonOriginalLabel(button) {
    if (!button) return;
    if (!button.dataset.originalLabel) {
      button.dataset.originalLabel = button.textContent ?? "";
    }
  }

  function resetButtonState(button) {
    if (!button) return;
    clearButtonStateTimer(button);
    const originalLabel = button.dataset.originalLabel;
    if (typeof originalLabel === "string") {
      button.textContent = originalLabel;
    }
    delete button.dataset.state;
    button.removeAttribute("aria-busy");
  }

  function setButtonState(button, options = {}) {
    if (!button) return;
    ensureButtonOriginalLabel(button);
    const { state: btnState, label, disable, restoreAfterMs } = options;
    if (btnState) {
      button.dataset.state = btnState;
      if (btnState === "loading") {
        button.setAttribute("aria-busy", "true");
      } else {
        button.removeAttribute("aria-busy");
      }
    } else {
      delete button.dataset.state;
      button.removeAttribute("aria-busy");
    }
    if (typeof label === "string") {
      button.textContent = label;
    }
    if (typeof disable === "boolean") {
      button.disabled = disable;
    }
    if (restoreAfterMs && restoreAfterMs > 0) {
      clearButtonStateTimer(button);
      const timerId = window.setTimeout(() => {
        resetButtonState(button);
        identityButtonTimers.delete(button);
      }, restoreAfterMs);
      identityButtonTimers.set(button, timerId);
    }
  }

  // ── formatting helpers ──────────────────────────────────────────

  function formatIdentityDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0 || days > 0) parts.push(`${hours}h`);
    if (minutes > 0 && parts.length < 3) parts.push(`${minutes}m`);
    if (parts.length < 3) parts.push(`${seconds}s`);
    return parts.join(" ");
  }

  // ── copy feedback ───────────────────────────────────────────────

  function showIdentityCopyFeedback(message, { error = false, entry } = {}) {
    const targets = entry ? [entry] : Array.from(identityDomEntries);
    targets.forEach((target) => {
      const feedback = target.copyFeedback;
      if (!feedback) return;
      feedback.textContent = message;
      feedback.hidden = false;
      if (error) {
        feedback.dataset.state = "error";
      } else {
        feedback.dataset.state = "success";
      }
      const existingTimeout = identityCopyFeedbackTimeouts.get(target);
      if (existingTimeout) {
        window.clearTimeout(existingTimeout);
      }
      const timeoutId = window.setTimeout(() => {
        const currentFeedback = target.copyFeedback;
        if (!currentFeedback) return;
        currentFeedback.hidden = true;
        delete currentFeedback.dataset.state;
      }, 2000);
      identityCopyFeedbackTimeouts.set(target, timeoutId);
      if (target.copyButton) {
        target.copyButton.dataset.state = error ? "error" : "success";
        window.setTimeout(() => {
          if (target.copyButton) {
            delete target.copyButton.dataset.state;
          }
        }, error ? 2500 : 1500);
      }
    });
  }

  // ── countdown ───────────────────────────────────────────────────

  function stopIdentityCountdown() {
    if (identityCountdownIntervalId !== null) {
      window.clearInterval(identityCountdownIntervalId);
      identityCountdownIntervalId = null;
    }
  }

  function updateIdentityCountdown() {
    pruneIdentityDomEntries();
    const expiresAt = state.identity.expiresAt;
    const authenticated = state.identity.authenticated;
    const expirationKnown = isFiniteNumber(expiresAt);
    identityDomEntries.forEach((entry) => {
      const expiry = entry.expiry;
      if (!expiry) return;
      if (!expirationKnown) {
        expiry.textContent = authenticated ? "Session expiry unknown" : "\u2014";
        expiry.dataset.state = authenticated ? "unknown" : "inactive";
        expiry.title = "";
        return;
      }
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) {
        expiry.textContent = "Session expired";
        expiry.dataset.state = "expired";
        expiry.title = new Date(expiresAt).toLocaleString();
        return;
      }
      expiry.textContent = `Expires in ${formatIdentityDuration(remaining)}`;
      expiry.dataset.state = "active";
      expiry.title = new Date(expiresAt).toLocaleString();
    });
    if (expirationKnown && expiresAt - Date.now() <= 0) {
      stopIdentityCountdown();
    }
  }

  function startIdentityCountdown() {
    stopIdentityCountdown();
    if (!state.identity.authenticated || !isFiniteNumber(state.identity.expiresAt)) {
      return;
    }
    const hasExpiryTarget = Array.from(identityDomEntries).some((entry) => Boolean(entry.expiry));
    if (!hasExpiryTarget) {
      return;
    }
    updateIdentityCountdown();
    identityCountdownIntervalId = window.setInterval(() => {
      updateIdentityCountdown();
    }, 1000);
  }

  // ── persistence ─────────────────────────────────────────────────

  function persistIdentityState(identity) {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }
    try {
      if (identity.npub) {
        const payload = {
          npub: identity.npub,
          method: identity.method,
          expiresAt: identity.expiresAt ?? null,
          alias: identity.alias ?? null,
          profileName: identity.profileName ?? null,
          picture: identity.picture ?? null,
          ports: Array.isArray(identity.ports) ? [...identity.ports] : [],
          botNpub: identity.botNpub ?? null,
          botDisplayName: identity.botDisplayName ?? null,
          botPubkeyHex: identity.botPubkeyHex ?? null,
          botUnlocked: identity.botUnlocked ?? false,
          botCanExportNsec: Boolean(identity.botCanExportNsec),
          botKeySource: identity.botKeySource ?? null,
        };
        window.localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(payload));
      } else {
        window.localStorage.removeItem(IDENTITY_STORAGE_KEY);
      }
    } catch {
      // ignore storage errors
    }
  }

  // ── display sync ────────────────────────────────────────────────

  function syncIdentityDisplayForEntry(entry) {
    const { npub, method, authenticated, expiresAt, alias, profileName } = state.identity;
    if (entry.root) {
      if (authenticated) {
        entry.root.dataset.authenticated = "true";
      } else {
        delete entry.root.dataset.authenticated;
      }
    }
    if (entry.details) {
      entry.details.hidden = !authenticated;
    }
    if (entry.registerSection) {
      entry.registerSection.hidden = authenticated;
    }
    if (entry.alias) {
      if (!authenticated) {
        entry.alias.textContent = "Not signed in";
        entry.alias.removeAttribute("title");
      } else {
        const abbreviated = npub ? abbreviateNpub(npub) : "";
        const displayName = profileName || alias;
        if (displayName && abbreviated) {
          entry.alias.textContent = `${displayName} (${abbreviated})`;
          entry.alias.title = npub;
        } else if (abbreviated) {
          entry.alias.textContent = abbreviated;
          entry.alias.title = npub;
        } else if (displayName) {
          entry.alias.textContent = displayName;
          entry.alias.removeAttribute("title");
        } else {
          entry.alias.textContent = "Not signed in";
          entry.alias.removeAttribute("title");
        }
      }
    }
    if (entry.npub) {
      if (npub) {
        entry.npub.textContent = abbreviateNpub(npub);
        entry.npub.title = npub;
      } else {
        entry.npub.textContent = "Not signed in";
        entry.npub.removeAttribute("title");
      }
    }
    if (entry.method) {
      entry.method.textContent = authenticated ? (identityMethodLabels[method] ?? method ?? "Unknown") : "\u2014";
    }
    if (entry.copyButton) {
      entry.copyButton.disabled = !npub;
    }
    if (entry.copyNpubButton) {
      entry.copyNpubButton.disabled = !authenticated || !npub;
    }
    if (entry.logoutButton) {
      if (!authenticated) {
        resetButtonState(entry.logoutButton);
        entry.logoutButton.disabled = true;
      } else {
        entry.logoutButton.disabled = false;
      }
    }
    if (entry.copyFeedback && !npub) {
      entry.copyFeedback.hidden = true;
      delete entry.copyFeedback.dataset.state;
    }
    if (entry.expiry) {
      if (!authenticated) {
        entry.expiry.textContent = "\u2014";
        entry.expiry.dataset.state = "inactive";
        entry.expiry.removeAttribute("title");
      } else if (!isFiniteNumber(expiresAt)) {
        entry.expiry.textContent = "Session expiry unknown";
        entry.expiry.dataset.state = "unknown";
        entry.expiry.removeAttribute("title");
      } else {
        updateIdentityCountdown();
      }
    }
    // ── Bot identity display ──────────────────────────────────────
    const { botNpub, botDisplayName, botPubkeyHex, botUnlocked, botCanExportNsec, botKeySource } = state.identity;
    const hasBotKey = Boolean(botNpub);
    const isWingmanPrivManaged = botKeySource === "wingman_priv";
    const canExportBotNsec = Boolean(hasBotKey && botCanExportNsec && state.identity.isAdmin);
    if (entry.botHeader) {
      entry.botHeader.hidden = !authenticated;
      // Also hide the spacer dd (next sibling)
      const spacer = entry.botHeader.nextElementSibling;
      if (spacer) spacer.hidden = !authenticated;
    }
    if (entry.botNpub) {
      if (hasBotKey) {
        entry.botNpub.textContent = abbreviateNpub(botNpub);
        entry.botNpub.title = botNpub;
      } else {
        entry.botNpub.textContent = authenticated ? "Not generated" : "\u2014";
        entry.botNpub.removeAttribute("title");
      }
    }
    if (entry.botName) {
      if (hasBotKey && botDisplayName) {
        entry.botName.textContent = botDisplayName;
        entry.botName.title = botDisplayName;
      } else {
        entry.botName.textContent = authenticated ? "Not generated" : "\u2014";
        entry.botName.removeAttribute("title");
      }
    }
    if (entry.botPubkey) {
      if (botPubkeyHex) {
        const abbreviated = `${botPubkeyHex.slice(0, 8)}...${botPubkeyHex.slice(-8)}`;
        entry.botPubkey.textContent = abbreviated;
        entry.botPubkey.title = botPubkeyHex;
      } else {
        entry.botPubkey.textContent = authenticated ? "Not generated" : "\u2014";
        entry.botPubkey.removeAttribute("title");
      }
    }
    if (entry.botStatus) {
      if (!authenticated) {
        entry.botStatus.textContent = "\u2014";
        delete entry.botStatus.dataset.state;
      } else if (!hasBotKey) {
        entry.botStatus.textContent = "Missing WINGMAN_PRIV";
        entry.botStatus.dataset.state = "inactive";
      } else if (isWingmanPrivManaged) {
        entry.botStatus.textContent = "Env managed";
        entry.botStatus.dataset.state = "active";
      } else if (botUnlocked) {
        entry.botStatus.textContent = "Unlocked";
        entry.botStatus.dataset.state = "active";
      } else {
        entry.botStatus.textContent = "Locked";
        entry.botStatus.dataset.state = "locked";
      }
    }
    if (entry.botCopyButton) {
      entry.botCopyButton.disabled = !hasBotKey;
    }
    if (entry.botCopyFeedback && !hasBotKey) {
      entry.botCopyFeedback.hidden = true;
      delete entry.botCopyFeedback.dataset.state;
    }
    if (entry.botExportButton) {
      entry.botExportButton.disabled = !canExportBotNsec;
      entry.botExportButton.hidden = !state.identity.isAdmin;
    }
    if (entry.botExportLabel) {
      entry.botExportLabel.hidden = !state.identity.isAdmin;
    }
    if (entry.botExportRow) {
      entry.botExportRow.hidden = !state.identity.isAdmin;
    }
    if (entry.botExportFeedback && !canExportBotNsec) {
      entry.botExportFeedback.hidden = true;
      delete entry.botExportFeedback.dataset.state;
    }
    if (entry.botPublishDelegateButton) {
      entry.botPublishDelegateButton.disabled = !hasBotKey || isWingmanPrivManaged;
      entry.botPublishDelegateButton.hidden = isWingmanPrivManaged;
    }
    if (entry.botForceSetupButton) {
      entry.botForceSetupButton.disabled = !authenticated || isWingmanPrivManaged || !hasBotKey;
      entry.botForceSetupButton.hidden = isWingmanPrivManaged || !hasBotKey;
    }
    if (entry.botPublishDelegateFeedback && !hasBotKey) {
      entry.botPublishDelegateFeedback.hidden = true;
      delete entry.botPublishDelegateFeedback.dataset.state;
    }
  }

  function syncIdentityDisplay() {
    pruneIdentityDomEntries();
    identityDomEntries.forEach((entry) => {
      syncIdentityDisplayForEntry(entry);
    });
    requestAuthUiSync();
    if (state.identity.authenticated && isFiniteNumber(state.identity.expiresAt)) {
      startIdentityCountdown();
    } else {
      stopIdentityCountdown();
    }
  }

  // ── DOM entry management ────────────────────────────────────────

  function detachIdentityDomEntry(entry) {
    if (!entry) return;
    if (entry.copyButton && entry.copyHandler) {
      entry.copyButton.removeEventListener("click", entry.copyHandler);
      identityDomEntryByNode.delete(entry.copyButton);
      resetButtonState(entry.copyButton);
    }
    if (entry.registerButton && entry.registerHandler) {
      entry.registerButton.removeEventListener("click", entry.registerHandler);
      identityDomEntryByNode.delete(entry.registerButton);
      resetButtonState(entry.registerButton);
    }
    if (entry.logoutButton && entry.logoutHandler) {
      entry.logoutButton.removeEventListener("click", entry.logoutHandler);
      identityDomEntryByNode.delete(entry.logoutButton);
      resetButtonState(entry.logoutButton);
    }
    if (entry.botCopyButton && entry.botCopyHandler) {
      entry.botCopyButton.removeEventListener("click", entry.botCopyHandler);
      identityDomEntryByNode.delete(entry.botCopyButton);
      resetButtonState(entry.botCopyButton);
    }
    if (entry.botExportButton && entry.botExportHandler) {
      entry.botExportButton.removeEventListener("click", entry.botExportHandler);
      identityDomEntryByNode.delete(entry.botExportButton);
      resetButtonState(entry.botExportButton);
    }
    if (entry.botPublishDelegateButton && entry.botPublishDelegateHandler) {
      entry.botPublishDelegateButton.removeEventListener("click", entry.botPublishDelegateHandler);
      identityDomEntryByNode.delete(entry.botPublishDelegateButton);
      resetButtonState(entry.botPublishDelegateButton);
    }
    if (entry.botForceSetupButton && entry.botForceSetupHandler) {
      entry.botForceSetupButton.removeEventListener("click", entry.botForceSetupHandler);
      identityDomEntryByNode.delete(entry.botForceSetupButton);
      resetButtonState(entry.botForceSetupButton);
    }
    if (entry.workspaceDelegationUseBotButton && entry.workspaceDelegationUseBotHandler) {
      entry.workspaceDelegationUseBotButton.removeEventListener("click", entry.workspaceDelegationUseBotHandler);
      resetButtonState(entry.workspaceDelegationUseBotButton);
    }
    if (entry.workspaceDelegationRefreshButton && entry.workspaceDelegationRefreshHandler) {
      entry.workspaceDelegationRefreshButton.removeEventListener("click", entry.workspaceDelegationRefreshHandler);
      resetButtonState(entry.workspaceDelegationRefreshButton);
    }
    if (entry.workspaceDelegationForm && entry.workspaceDelegationSubmitHandler) {
      entry.workspaceDelegationForm.removeEventListener("submit", entry.workspaceDelegationSubmitHandler);
    }
    if (entry.workspaceDelegationsList && entry.workspaceDelegationListHandler) {
      entry.workspaceDelegationsList.removeEventListener("click", entry.workspaceDelegationListHandler);
    }
    if (entry.workspaceDelegationCreateButton) {
      resetButtonState(entry.workspaceDelegationCreateButton);
    }
    const timeoutId = identityCopyFeedbackTimeouts.get(entry);
    if (timeoutId) {
      window.clearTimeout(timeoutId);
      identityCopyFeedbackTimeouts.delete(entry);
    }
  }

  function pruneIdentityDomEntries() {
    const staleEntries = [];
    identityDomEntries.forEach((entry) => {
      if (!entry.root || !entry.root.isConnected) {
        staleEntries.push(entry);
      }
    });
    staleEntries.forEach((entry) => {
      detachIdentityDomEntry(entry);
      identityDomEntries.delete(entry);
    });
    if (staleEntries.length > 0 && identityDomEntries.size === 0) {
      stopIdentityCountdown();
    }
  }

  // ── public API ──────────────────────────────────────────────────

  return {
    IDENTITY_STORAGE_KEY,
    IDENTITY_EVENT_NAMES,
    identityDomEntries,
    identityDomEntryByNode,
    identityCopyFeedbackTimeouts,
    identityButtonTimers,
    clearButtonStateTimer,
    ensureButtonOriginalLabel,
    resetButtonState,
    setButtonState,
    formatIdentityDuration,
    showIdentityCopyFeedback,
    stopIdentityCountdown,
    startIdentityCountdown,
    persistIdentityState,
    syncIdentityDisplayForEntry,
    syncIdentityDisplay,
    pruneIdentityDomEntries,
    detachIdentityDomEntry,
  };
}

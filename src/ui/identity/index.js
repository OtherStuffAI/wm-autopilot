const UNLOCK_CODE_DIALOG_ID = "identity-unlock-code-dialog";
const SESSION_STORAGE_KEY = "nostr_session";
const DEFAULT_CONNECT_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.primal.net",
  "ws://127.0.0.1:4869",
];
const NOSTR_CONNECT_SECRET_TTL_MS = 5 * 60 * 1000;
const KEYTELEPORT_PARAM = "keyteleport";

import { finalizeEvent, nip19, nip44 } from "/vendor/nostr-tools/index.js";
import { schnorr, secp256k1 } from "/vendor/@noble/curves/secp256k1.js";
import { renderQrCode } from "./nostrconnect-qr.js";
import * as deviceKeystore from "./device-keystore.js";
import { showToast } from "../utils/toast.js";
import { signIdentityEvent } from "./event-signer.js";
import { persistServerSession } from "./login-session.js";

// bunker-client.js (1.4 MB) is lazy-loaded only when Nostr Connect is needed
let _bunkerModule = null;
async function loadBunkerClient() {
  if (_bunkerModule) return _bunkerModule;
  _bunkerModule = await import("/vendor/bunker-client.js");
  ensureSecretlessBunkerSupport();
  return _bunkerModule;
}
function getBunkerModule() {
  if (!_bunkerModule) throw new Error("bunker-client not loaded yet — call loadBunkerClient() first");
  return _bunkerModule;
}

class PasswordPromptCancelledError extends Error {
  constructor() {
    super("Prompt cancelled");
    this.name = "PasswordPromptCancelledError";
  }
}

const getCrypto = () => {
  if (typeof globalThis !== "undefined" && globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
    return globalThis.crypto;
  }
  throw new Error("Secure random generator unavailable");
};

const randomBytes = (length) => {
  const crypto = getCrypto();
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
};

const wipeBytes = (bytes) => {
  if (!bytes) return;
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = 0;
  }
};

const sessionCache = {
  save(session) {
    if (typeof window === "undefined" || !window.localStorage) return;
    const payload = {
      schema: 1,
      npub: session.npub ?? null,
      sessionExpiresAt: session.sessionExpiresAt ?? null,
      method: session.method ?? "local_keys",
      createdAt: Date.now(),
    };
    try {
      window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // ignore storage failures
    }
  },
  load() {
    if (typeof window === "undefined" || !window.localStorage) return null;
    try {
      const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      if (parsed.sessionExpiresAt && Number.isFinite(parsed.sessionExpiresAt)) {
        if (Date.now() > Number(parsed.sessionExpiresAt)) {
          window.localStorage.removeItem(SESSION_STORAGE_KEY);
          return null;
        }
      }
      return parsed;
    } catch {
      return null;
    }
  },
  clear() {
    if (typeof window === "undefined" || !window.localStorage) return;
    try {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // ignore
    }
  },
};

const BUNKER_SESSION_STORAGE_KEY = "wingman_identity_bunker_session";
const BUNKER_PERMISSION_KINDS = [22242, 0, 1, 3, 4, 5, 7, 10002];
const BUNKER_PERMISSION_FEATURES = ["nip04_encrypt", "nip04_decrypt", "nip44_encrypt", "nip44_decrypt"];
// Computed lazily after bunker-client is loaded
let _bunkerSigningPermissions = null;
function getBunkerSigningPermissions() {
  if (!_bunkerSigningPermissions) {
    const { NostrConnectSigner } = getBunkerModule();
    _bunkerSigningPermissions = [
      ...BUNKER_PERMISSION_FEATURES,
      ...NostrConnectSigner.buildSigningPermissions(BUNKER_PERMISSION_KINDS),
    ];
  }
  return _bunkerSigningPermissions;
}
let bunkerPatchedForSecretless = false;
let bunkerRelayPool = null;
let bunkerRestorePromise = null;
let activeBunkerSigner = null;

const parseRelayList = (value) => {
  if (!value) return [];
  const entries = Array.isArray(value) ? value : String(value).split(",");
  return Array.from(
    new Set(
      entries
        .map((entry) => (entry && typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0),
    ),
  );
};

const deriveConnectRelays = (context) => {
  const config = typeof context?.getConfig === "function" ? context.getConfig() : null;
  const configRelays = parseRelayList(config?.connectRelays);
  if (configRelays.length > 0) return configRelays;
  const apiRelays = parseRelayList(identityApi?.connectRelays);
  if (apiRelays.length > 0) return apiRelays;
  return [...DEFAULT_CONNECT_RELAYS];
};

const buildNostrConnectMetadata = () => {
  if (typeof window === "undefined" || typeof window.location === "undefined") {
    return { name: "Wingman" };
  }
  return {
    name: "Wingman",
    url: window.location.origin,
  };
};

const getRelayPool = () => {
  if (!bunkerRelayPool) {
    const { RelayPool } = getBunkerModule();
    bunkerRelayPool = new RelayPool();
  }
  return bunkerRelayPool;
};

// Some bunkers deliberately omit a secret and rely on manual approval. The
// applesauce signer always sends an empty string when the secret is missing,
// which can be treated by some providers as an incorrect secret instead of
// "no secret". Normalize that case to `null` so secretless bunkers are
// recognized correctly.
function ensureSecretlessBunkerSupport() {
  if (bunkerPatchedForSecretless) return;
  const { NostrConnectSigner } = getBunkerModule();
  const originalMakeRequest = NostrConnectSigner.prototype.makeRequest;
  if (typeof originalMakeRequest !== "function") return;
  NostrConnectSigner.prototype.makeRequest = function patchedMakeRequest(method, params, kind) {
    if (method === "connect" && Array.isArray(params) && params.length >= 2) {
      const nextParams = [...params];
      if (nextParams[1] === "" || typeof nextParams[1] === "undefined") {
        nextParams[1] = null;
      }
      return originalMakeRequest.call(this, method, nextParams, kind);
    }
    return originalMakeRequest.call(this, method, params, kind);
  };
  bunkerPatchedForSecretless = true;
}

const loadBunkerSession = () => {
  if (typeof window === "undefined" || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(BUNKER_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const remote = typeof parsed.remote === "string" ? parsed.remote : null;
    const relays = Array.isArray(parsed.relays)
      ? parsed.relays.filter((entry) => typeof entry === "string" && entry.trim().length > 0)
      : [];
    if (!remote || relays.length === 0) return null;
    return {
      remote,
      relays,
      pubkey: typeof parsed.pubkey === "string" ? parsed.pubkey : null,
      hasSecret: Boolean(parsed.hasSecret),
      lastConnectedAt: typeof parsed.lastConnectedAt === "number" ? parsed.lastConnectedAt : null,
    };
  } catch {
    return null;
  }
};

const saveBunkerSession = (meta) => {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    const payload = {
      remote: meta.remote,
      relays: Array.isArray(meta.relays) ? meta.relays : [],
      pubkey: meta.pubkey ?? null,
      hasSecret: Boolean(meta.hasSecret),
      lastConnectedAt: meta.lastConnectedAt ?? Date.now(),
    };
    window.localStorage.setItem(BUNKER_SESSION_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn("[identity] failed to persist bunker session", error instanceof Error ? error.message : error);
  }
};

const clearBunkerSession = () => {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.removeItem(BUNKER_SESSION_STORAGE_KEY);
  } catch (error) {
    console.warn("[identity] failed to clear bunker session", error instanceof Error ? error.message : error);
  }
};

const disconnectBunkerSigner = async () => {
  const signer = activeBunkerSigner ?? identityApi?.bunkerSigner ?? null;
  if (signer && typeof signer.close === "function") {
    try {
      await signer.close();
    } catch (error) {
      console.warn("[identity] failed to close bunker signer", error instanceof Error ? error.message : error);
    }
  }
  activeBunkerSigner = null;
  if (identityApi) {
    identityApi.bunkerSigner = null;
  }
};

const attemptBunkerRestore = async ({ context, setStatus, form, enableInputs, root }) => {
  if (typeof window === "undefined") return null;
  const stored = loadBunkerSession();
  if (!stored) return null;
  const cached = identityApi.sessionCache?.load?.();
  if (!cached || cached.method !== "bunker") {
    if (stored.hasSecret) {
      setStatus("Stored remote signer requires a secret. Paste the bunker URI again to reconnect.", "warning");
    }
    return null;
  }
  if (stored.hasSecret) {
    console.log("[identity] stored bunker session requires secret, clearing cached session");
    setStatus("Your bunker session has expired. Please paste your bunker URI again to reconnect.", "warning");
    clearBunkerSession();
    return null;
  }
  setStatus("Reconnecting to remote signer…");
  form?.classList.add("is-loading");
  enableInputs(false);
  try {
    await loadBunkerClient();
    await disconnectBunkerSigner();
    const { NostrConnectSigner } = getBunkerModule();
    const signer = new NostrConnectSigner({
      relays: stored.relays,
      remote: stored.remote,
      pubkey: stored.pubkey ?? undefined,
      pool: getRelayPool(),
    });
    await signer.connect(undefined, getBunkerSigningPermissions());
    activeBunkerSigner = signer;
    identityApi.bunkerSigner = signer;
    const pubkeyHex = await signer.getPublicKey();
    const npub = nip19.npubEncode(pubkeyHex);
    let expiresAt = cached?.sessionExpiresAt ?? null;
    try {
      const refreshed = await persistServerSession(npub, null, (event) => signer.signEvent(event));
      if (refreshed.expiresAt) {
        expiresAt = refreshed.expiresAt;
      }
    } catch (error) {
      console.warn("[identity] failed to refresh bunker session cookie", error instanceof Error ? error.message : error);
    }
    saveBunkerSession({
      remote: signer.remote ?? stored.remote,
      relays: Array.isArray(signer.relays) ? signer.relays : stored.relays,
      pubkey: pubkeyHex,
      hasSecret: false,
      lastConnectedAt: Date.now(),
    });
    saveCachedSession({ npub, expiresAt, method: "bunker" });
    applyIdentityUpdate(context, { npub, method: "bunker", expiresAt, isAuthenticated: true });
    root.classList.add("is-authenticated");
    setStatus("Reconnected to remote signer", "success");
    return npub;
  } catch (error) {
    await disconnectBunkerSigner();
    console.warn("[identity] bunker restore failed", error instanceof Error ? error.message : error);
    const message = error instanceof Error ? error.message : "Failed to reconnect to remote signer";
    setStatus(message, "error");
    root.classList.remove("is-authenticated");
    return null;
  } finally {
    form?.classList.remove("is-loading");
    enableInputs(true);
  }
};

const createNostrConnectController = ({ root, context, onConnected }) => {
  const section = root.querySelector('[data-section="nostrconnect"]');
  if (!section) return null;

  const urlInput = section.querySelector('[data-role="nostrconnect-url"]');
  const statusEl = section.querySelector('[data-role="nostrconnect-status"]');
  const relaysEl = section.querySelector('[data-role="nostrconnect-relays"]');
  const qrContainer = section.querySelector('[data-role="nostrconnect-qr"]');
  const qrCanvas = section.querySelector('[data-role="nostrconnect-qr-canvas"]');
  const copyButton = section.querySelector('[data-action="copy-nostrconnect-url"]');
  const qrButton = section.querySelector('[data-action="show-nostrconnect-qr"]');

  let currentOffer = null;
  let abortController = null;
  let expiryTimer = null;

  if (root.classList.contains("is-authenticated")) {
    section.hidden = true;
  }

  const setNostrStatus = (message, state = "info") => setPanelStatus(statusEl, message, state);

  const updateRelaysLabel = (relays) => {
    if (!relaysEl) return;
    if (!Array.isArray(relays) || relays.length === 0) {
      relaysEl.textContent = "Relays unavailable. Set CONNECT_RELAYS or use defaults.";
      return;
    }
    if (relays.length === DEFAULT_CONNECT_RELAYS.length && relays.every((value, idx) => value === DEFAULT_CONNECT_RELAYS[idx])) {
      relaysEl.textContent = `Relays: ${relays.join(", ")}`;
      return;
    }
    relaysEl.textContent = `Relays (CONNECT_RELAYS): ${relays.join(", ")}`;
  };

  const toggleControls = (disabled) => {
    if (copyButton) copyButton.disabled = disabled;
    if (qrButton) qrButton.disabled = disabled;
    if (urlInput) urlInput.disabled = disabled;
  };

  const stopWaiting = async ({ keepSigner = false } = {}) => {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    if (expiryTimer) {
      clearTimeout(expiryTimer);
      expiryTimer = null;
    }
    if (!keepSigner && currentOffer?.signer && typeof currentOffer.signer.close === "function") {
      try {
        await currentOffer.signer.close();
      } catch (error) {
        console.warn("[identity] failed to close nostrconnect signer", error instanceof Error ? error.message : error);
      }
    }
  };

  const handleConnected = async (offer) => {
    if (!offer) return null;
    await stopWaiting({ keepSigner: true });
    try {
      await disconnectBunkerSigner();
      activeBunkerSigner = offer.signer;
      identityApi.bunkerSigner = offer.signer;
      const pubkeyHex = await offer.signer.getPublicKey();
      const npub = nip19.npubEncode(pubkeyHex);
      const { expiresAt } = await persistServerSession(npub, null, (event) => offer.signer.signEvent(event));
      saveBunkerSession({
        remote: offer.signer.remote ?? null,
        relays: Array.isArray(offer.relays) ? offer.relays : deriveConnectRelays(context),
        pubkey: pubkeyHex,
        hasSecret: true,
        lastConnectedAt: Date.now(),
      });
      saveCachedSession({ npub, expiresAt, method: "bunker" });
      applyIdentityUpdate(context, { npub, method: "bunker", expiresAt, isAuthenticated: true, alias: npub });
      root.classList.add("is-authenticated");
      section.hidden = true;
      setNostrStatus("Connected to remote signer", "success");
      if (typeof onConnected === "function") {
        onConnected({ npub, expiresAt });
      }
      currentOffer = null;
      return npub;
    } catch (error) {
      console.error("[identity] nostrconnect completion failed", error);
      setNostrStatus("Failed to finalize connection from nostrconnect", "error");
      return null;
    }
  };

  const awaitRemoteSigner = (offer) => {
    if (!offer) return;
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    if (expiryTimer) {
      clearTimeout(expiryTimer);
      expiryTimer = null;
    }
    abortController = typeof AbortController === "function" ? new AbortController() : null;
    if (typeof window !== "undefined") {
      expiryTimer = window.setTimeout(() => {
        if (abortController) abortController.abort();
      }, NOSTR_CONNECT_SECRET_TTL_MS);
    }
    setNostrStatus("Waiting for remote signer…");
    offer.signer
      .waitForSigner(abortController?.signal)
      .then(() => handleConnected(offer))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (abortController?.signal?.aborted) {
          setNostrStatus("Connection request expired. Regenerate to try again.", "warning");
        } else {
          console.warn("[identity] nostrconnect wait failed", message);
          setNostrStatus("Failed to receive response from bunker. Try again.", "error");
        }
        currentOffer = null;
        if (abortController?.signal?.aborted) {
          void refreshOffer();
        }
      })
      .finally(() => {
        if (expiryTimer) {
          clearTimeout(expiryTimer);
          expiryTimer = null;
        }
        abortController = null;
      });
  };

  const refreshOffer = async () => {
    toggleControls(true);
    await stopWaiting({ keepSigner: false });
    const relays = deriveConnectRelays(context);
    updateRelaysLabel(relays);
    if (!relays || relays.length === 0) {
      setNostrStatus("No relays configured for nostrconnect. Set CONNECT_RELAYS and retry.", "error");
      if (urlInput) urlInput.value = "";
      toggleControls(false);
      return null;
    }
    try {
      await loadBunkerClient();
      const { NostrConnectSigner } = getBunkerModule();
      const metadata = buildNostrConnectMetadata();
      const signer = new NostrConnectSigner({
        relays,
        pool: getRelayPool(),
      });
      const url = signer.getNostrConnectURI({ ...metadata, permissions: getBunkerSigningPermissions() });
      currentOffer = {
        signer,
        url,
        relays,
        createdAt: Date.now(),
      };
      if (urlInput) {
        urlInput.value = url;
        urlInput.title = url;
        urlInput.readOnly = true;
      }
      if (qrContainer) {
        qrContainer.hidden = true;
      }
      setNostrStatus("Share this nostrconnect link with your bunker to finish signing in.", "info");
      toggleControls(false);
      awaitRemoteSigner(currentOffer);
      return url;
    } catch (error) {
      console.error("[identity] failed to generate nostrconnect URL", error);
      setNostrStatus("Failed to generate nostrconnect link. Try again.", "error");
      toggleControls(false);
      return null;
    }
  };

  const ensureOffer = async () => {
    if (currentOffer) return currentOffer;
    await refreshOffer();
    return currentOffer;
  };

  const handleCopy = async () => {
    const offer = await ensureOffer();
    if (!offer?.url) {
      setNostrStatus("Unable to copy. Regenerate the nostrconnect link.", "error");
      return;
    }
    const success = await copyToClipboard(offer.url);
    if (success) {
      setNostrStatus("nostrconnect link copied", "success");
    } else {
      setNostrStatus("Copy failed. Select and copy manually.", "error");
    }
  };

  const toggleQr = async () => {
    const offer = await ensureOffer();
    if (!offer?.url || !qrContainer || !qrCanvas) return;
    if (!qrContainer.hidden) {
      qrContainer.hidden = true;
      return;
    }
    const rendered = await renderQrCode(offer.url, qrCanvas);
    if (!rendered) {
      setNostrStatus("Could not render QR. Copy the link instead.", "error");
      return;
    }
    qrContainer.hidden = false;
  };

  copyButton?.addEventListener("click", () => {
    void handleCopy();
  });
  qrButton?.addEventListener("click", () => {
    void toggleQr();
  });

  const reset = async ({ keepSigner = false } = {}) => {
    await stopWaiting({ keepSigner });
    currentOffer = null;
    if (qrContainer) {
      qrContainer.hidden = true;
    }
  };

  const handleLoginOpen = () => {
    if (root.classList.contains("is-authenticated")) {
      return;
    }
    void refreshOffer();
  };

  const handleLogout = () => {
    section.hidden = false;
    void refreshOffer();
  };

  const handleAuthenticated = () => {
    section.hidden = true;
  };

  return {
    refreshOffer,
    reset,
    handleLoginOpen,
    handleLogout,
    handleAuthenticated,
  };
};

let unlockCodeDialogElements = null;

const ensureUnlockCodeDialogElements = () => {
  if (unlockCodeDialogElements) {
    return unlockCodeDialogElements;
  }
  if (typeof document === "undefined") return null;
  const dialog = document.getElementById(UNLOCK_CODE_DIALOG_ID);
  if (!(dialog instanceof HTMLDialogElement)) return null;
  const form = dialog.querySelector('form[data-role="form"]');
  const unlockInput = form?.querySelector('[data-role="unlock-input"]') ?? null;
  const errorEl = form?.querySelector('[data-role="error"]') ?? null;
  const title = form?.querySelector('[data-role="title"]') ?? null;
  const description = form?.querySelector('[data-role="description"]') ?? null;

  unlockCodeDialogElements = {
    dialog,
    form,
    unlockInput,
    errorEl,
    title,
    description,
  };
  return unlockCodeDialogElements;
};

/**
 * Prompt user to paste an unlock code for Key Teleport v2
 * @param {Object} options
 * @param {string} [options.title] - Dialog title
 * @param {string} [options.message] - Dialog description message
 * @returns {Promise<string>} The unlock code entered by the user
 */
const promptForUnlockCode = async ({ title, message } = {}) => {
  const elements = ensureUnlockCodeDialogElements();
  if (!elements) {
    throw new Error("Unlock code dialog unavailable");
  }

  const { dialog, form, unlockInput, errorEl, title: titleEl, description: descriptionEl } = elements;
  if (!form || !unlockInput || !dialog) {
    throw new Error("Unlock code dialog incomplete");
  }

  if (titleEl && title) {
    titleEl.textContent = title;
  }
  if (descriptionEl && message) {
    descriptionEl.textContent = message;
  }

  unlockInput.value = "";
  if (errorEl) {
    errorEl.hidden = true;
    errorEl.textContent = "";
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      dialog.removeEventListener("close", handleClose);
      form.removeEventListener("submit", handleSubmit);
    };

    const handleClose = () => {
      cleanup();
      const returnValue = dialog.returnValue;
      if (returnValue === "cancel" || !returnValue) {
        reject(new PasswordPromptCancelledError());
        return;
      }
      const code = unlockInput.value.trim();
      if (!code) {
        reject(new Error("No unlock code provided"));
        return;
      }
      resolve(code);
    };

    const handleSubmit = (e) => {
      e.preventDefault();
      const code = unlockInput.value.trim();
      if (!code) {
        if (errorEl) {
          errorEl.textContent = "Please paste your unlock code";
          errorEl.hidden = false;
        }
        return;
      }
      dialog.close("confirm");
    };

    dialog.addEventListener("close", handleClose, { once: true });
    form.addEventListener("submit", handleSubmit);
    dialog.showModal();
    unlockInput.focus();
  });
};

const identityApi = typeof globalThis !== "undefined" && globalThis.wingmanIdentity ? globalThis.wingmanIdentity : {};

const getIdentityUiApi = () => {
  if (typeof globalThis === "undefined") return null;
  const candidate = globalThis.wingmanIdentityUI;
  return candidate && typeof candidate === "object" ? candidate : null;
};

const hexToBytes = (hex) => {
  const normalized = hex.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length % 2 !== 0 || /[^0-9a-f]/.test(normalized)) {
    throw new Error("Invalid hex value");
  }
  const length = normalized.length / 2;
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    const offset = index * 2;
    bytes[index] = Number.parseInt(normalized.slice(offset, offset + 2), 16);
  }
  return bytes;
};

const parseNsecValue = (input) => {
  if (!input || typeof input !== "string") {
    throw new Error("Private key value is required");
  }
  const value = input.trim();
  if (!value) {
    throw new Error("Private key value is required");
  }
  try {
    const decoded = nip19.decode(value);
    if (decoded.type !== "nsec") {
      throw new Error("Only nsec keys are supported");
    }
    const data = decoded.data;
    if (data instanceof Uint8Array) {
      return data;
    }
    if (typeof data === "string") {
      return hexToBytes(data);
    }
    throw new Error("Unsupported nsec payload");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Only nsec")) {
      throw error;
    }
    // Allow raw hex fallback
    const hex = value.toLowerCase();
    if (/^[0-9a-f]{64}$/.test(hex)) {
      return hexToBytes(hex);
    }
    throw new Error("Invalid nsec format");
  }
};

const bytesToHex = (bytes) => {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error("Expected Uint8Array");
  }
  let output = "";
  for (let index = 0; index < bytes.length; index += 1) {
    output += bytes[index].toString(16).padStart(2, "0");
  }
  return output;
};

const generateLocalSecretKey = () => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = randomBytes(32);
    if (candidate.some((byte) => byte !== 0) && secp256k1.utils.isValidPrivateKey(candidate)) {
      return candidate;
    }
  }
  throw new Error("Failed to generate valid private key");
};

function normalizeBunkerSecretParam(uri) {
  if (typeof uri !== "string" || uri.length === 0) {
    return uri;
  }
  return uri.replace(/([?&]secret=)([^&#]*)/i, (match, prefix, value) => {
    if (!value) {
      return match;
    }
    // Decode first in case it's already encoded, then re-encode properly
    try {
      const decoded = decodeURIComponent(value);
      const encoded = encodeURIComponent(decoded);
      return `${prefix}${encoded}`;
    } catch (error) {
      // If decode fails, just encode what we have
      return `${prefix}${encodeURIComponent(value)}`;
    }
  });
}

const applyIdentityUpdate = (context, partial) => {
  if (context && typeof context.updateIdentityState === "function") {
    context.updateIdentityState(partial);
    return;
  }
  const ui = getIdentityUiApi();
  if (ui && typeof ui.update === "function") {
    ui.update(partial);
  }
};

const saveCachedSession = ({ npub, expiresAt, method }) => {
  try {
    identityApi.sessionCache?.save({
      npub,
      sessionExpiresAt: expiresAt ?? null,
      method,
      createdAt: Date.now(),
    });
  } catch (error) {
    console.warn("[identity] Failed to cache session", error instanceof Error ? error.message : error);
  }
};

function setPanelStatus(element, message, state = "info") {
  if (!element) return;
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) {
    element.textContent = "";
    element.hidden = true;
    return;
  }
  element.textContent = message;
  element.dataset.state = state;
  element.hidden = false;
}

function fallbackCopyToClipboard(value) {
  try {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    document.body.append(textarea);
    textarea.select();
    const success = document.execCommand("copy");
    textarea.remove();
    return success;
  } catch {
    return false;
  }
}

async function copyToClipboard(value) {
  if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (error) {
      console.warn("[identity] navigator.clipboard.writeText failed", error instanceof Error ? error.message : error);
    }
  }
  return fallbackCopyToClipboard(value);
}

const performLogout = async () => {
  await disconnectBunkerSigner();
  clearBunkerSession();
  let error = null;
  try {
    const response = await fetch("/api/auth/session", {
      method: "DELETE",
      credentials: "include",
    });
    if (!response.ok && response.status !== 204) {
      const payload = await response.json().catch(() => ({}));
      const message = payload && typeof payload === "object" && typeof payload.error === "string" ? payload.error : `Failed to clear session (${response.status})`;
      error = new Error(message);
    }
  } catch (cause) {
    error = cause instanceof Error ? cause : new Error(String(cause));
  }

  try {
    identityApi.sessionCache?.clear?.();
  } catch (cause) {
    console.warn("[identity] failed to clear session cache", cause instanceof Error ? cause.message : cause);
  }

  // Clear device keystore
  if (deviceKeystore.isAvailable()) {
    try {
      await deviceKeystore.clearNsec();
    } catch (cause) {
      console.warn("[identity] failed to clear device keystore", cause instanceof Error ? cause.message : cause);
    }
  }

  applyIdentityUpdate(null, { npub: null, method: "none", expiresAt: null, isAuthenticated: false });
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("wingman:identity-logout"));
  }

  if (error) {
    throw error;
  }
};

const wireLocalIdentityPanel = (root, context) => {
  if (!root) return;
  const generateBtn = root.querySelector('[data-action="generate-keys"]');
  const npubOutput = root.querySelector('[data-role="npub"]');
  const importForm = root.querySelector('[data-form="import-nsec"]');

  const resetPanel = () => {
    if (npubOutput) {
      npubOutput.textContent = "";
    }
    root.classList.remove("is-authenticated");
  };

  const handleAuthSuccess = ({ npub, expiresAt, method }) => {
    if (npubOutput) {
      npubOutput.textContent = npub;
    }
    if (typeof root.open === "boolean") {
      root.open = true;
    }
    saveCachedSession({ npub, expiresAt, method });
    applyIdentityUpdate(context, { npub, method, expiresAt, isAuthenticated: true, alias: npub });
    root.classList.add("is-authenticated");
  };

  generateBtn?.addEventListener("click", async () => {
    if (!generateBtn) return;
    generateBtn.disabled = true;
    generateBtn.dataset.state = "pending";
    let secretKey;
    try {
      secretKey = generateLocalSecretKey();
      const publicKeyBytes = schnorr.getPublicKey(secretKey);
      const pubkeyHex = bytesToHex(publicKeyBytes);
      const npub = nip19.npubEncode(pubkeyHex);

      // Store in device keystore (Web Crypto + IndexedDB)
      if (deviceKeystore.isAvailable()) {
        try {
          await deviceKeystore.storeNsec(secretKey, { npub, method: "local_keys" });
        } catch (error) {
          console.warn("[identity] failed to store key in device keystore", error instanceof Error ? error.message : error);
        }
      }

      const { expiresAt } = await persistServerSession(
        npub,
        null,
        (event) => Promise.resolve(finalizeEvent(event, secretKey)),
      );

      handleAuthSuccess({ npub, expiresAt, method: "local_keys" });
    } catch (error) {
      console.error("[identity] generate keys failed", error);
      showToast(error instanceof Error ? error.message : "Failed to generate keys", { type: "error" });
    } finally {
      if (secretKey) {
        wipeBytes(secretKey);
      }
      generateBtn.disabled = false;
      delete generateBtn.dataset.state;
    }
  });

  importForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = importForm.querySelector('button[type="submit"]');
    const input = importForm.querySelector('textarea[name="nsec"], input[name="nsec"]');
    if (submitButton) submitButton.disabled = true;
    importForm.classList.add("is-loading");
    let secretKey;
    try {
      if (!input) {
        throw new Error("Missing nsec input");
      }
      secretKey = parseNsecValue(input.value);
      if (!secp256k1.utils.isValidPrivateKey(secretKey)) {
        throw new Error("Invalid private key provided");
      }
      const pubkeyHex = bytesToHex(schnorr.getPublicKey(secretKey));
      const npub = nip19.npubEncode(pubkeyHex);

      // Store in device keystore (Web Crypto + IndexedDB)
      if (deviceKeystore.isAvailable()) {
        try {
          await deviceKeystore.storeNsec(secretKey, { npub, method: "local_keys" });
        } catch (error) {
          console.warn("[identity] failed to store imported key in device keystore", error instanceof Error ? error.message : error);
        }
      }

      const { expiresAt } = await persistServerSession(
        npub,
        null,
        (event) => Promise.resolve(finalizeEvent(event, secretKey)),
      );
      handleAuthSuccess({ npub, expiresAt, method: "local_keys" });
      showToast("Signed in with imported key", { type: "success" });
    } catch (error) {
      console.error("[identity] import nsec failed", error);
      showToast(error instanceof Error ? error.message : "Failed to import key", { type: "error" });
    } finally {
      importForm.classList.remove("is-loading");
      if (submitButton) submitButton.disabled = false;
      if (secretKey) {
        wipeBytes(secretKey);
      }
    }
  });

  if (typeof window !== "undefined" && !root.dataset.logoutHooked) {
    window.addEventListener("wingman:identity-logout", resetPanel);
    root.dataset.logoutHooked = "true";
  }
};

const wireNip07Panel = (root, context) => {
  if (!root) return;
  const loginButton = root.querySelector('[data-action="nip07-login"]');
  const statusEl = root.querySelector('[data-role="nip07-status"]');

  const setStatus = (message, state = "info") => setPanelStatus(statusEl, message, state);

  loginButton?.addEventListener("click", async () => {
    if (!loginButton) return;
    if (typeof window === "undefined" || !window.nostr || typeof window.nostr.signEvent !== "function") {
      setStatus("No Nostr extension detected.", "error");
      return;
    }

    loginButton.disabled = true;
    setStatus("Requesting login signature from extension…");
    try {
      const pubkeyHex = await window.nostr.getPublicKey();
      if (!pubkeyHex || typeof pubkeyHex !== "string") {
        throw new Error("Extension returned an empty public key");
      }
      const npub = nip19.npubEncode(pubkeyHex);
      const { expiresAt } = await persistServerSession(
        npub,
        null,
        (event) => window.nostr.signEvent(event),
      );
      saveCachedSession({ npub, expiresAt, method: "nip07" });
      applyIdentityUpdate(context, { npub, method: "nip07", expiresAt, isAuthenticated: true, alias: npub });
      root.classList.add("is-authenticated");
      setStatus("Extension connected", "success");
    } catch (error) {
      console.error("[identity] nip07 login failed", error);
      setStatus(error instanceof Error ? error.message : "Failed to connect extension", "error");
    } finally {
      loginButton.disabled = false;
    }
  });

  if (typeof window !== "undefined" && !root.dataset.logoutStatusHooked) {
    window.addEventListener("wingman:identity-logout", () => {
      setStatus("");
    });
    root.dataset.logoutStatusHooked = "true";
  }
};

const initBunkerPanel = (root, context) => {
  if (!root) return null;
  if (root.__wingmanBunkerState) {
    return root.__wingmanBunkerState;
  }

  const form = root.querySelector('[data-form="bunker-auth"]');
  const textarea = form?.querySelector('textarea[name="bunkerUri"]');
  const submitButton = form?.querySelector('button[type="submit"]');
  const statusEl = root.querySelector('[data-role="bunker-status"]');
  const setStatus = (message, state = "info") => setPanelStatus(statusEl, message, state);
  const nostrConnect = createNostrConnectController({
    root,
    context,
    onConnected() {
      setStatus("Connected to remote signer", "success");
    },
  });

  const enableInputs = (enabled) => {
    if (textarea) textarea.disabled = !enabled;
    if (submitButton) submitButton.disabled = !enabled;
  };

  const connectWithUri = async (uri) => {
    const trimmed = typeof uri === "string" ? uri.trim() : "";
    if (!trimmed) {
      setStatus("Enter a bunker URI to connect.", "error");
      return;
    }
    const normalized = normalizeBunkerSecretParam(trimmed);
    let parsed = null;
    if (textarea) {
      textarea.value = trimmed;
    }
    setStatus("Connecting to remote signer…");
    form?.classList.add("is-loading");
    enableInputs(false);
    try {
      await loadBunkerClient();
      const { NostrConnectSigner } = getBunkerModule();
      console.log("[identity] connecting with normalized URI:", normalized.replace(/secret=([^&#]*)/i, 'secret=[REDACTED]'));
      parsed = NostrConnectSigner.parseBunkerURI(normalized);
      console.log("[identity] parsed bunker URI:", { remote: parsed.remote, relays: parsed.relays, hasSecret: !!parsed.secret });
      await disconnectBunkerSigner();
      const signer = await NostrConnectSigner.fromBunkerURI(normalized, {
        pool: getRelayPool(),
        permissions: getBunkerSigningPermissions(),
      });
      activeBunkerSigner = signer;
      identityApi.bunkerSigner = signer;
      const pubkeyHex = await signer.getPublicKey();
      const npub = nip19.npubEncode(pubkeyHex);
      const { expiresAt } = await persistServerSession(npub, null, (event) => signer.signEvent(event));
      saveBunkerSession({
        remote: signer.remote ?? parsed.remote,
        relays: Array.isArray(signer.relays) ? signer.relays : parsed.relays,
        pubkey: pubkeyHex,
        hasSecret: Boolean(parsed.secret),
        lastConnectedAt: Date.now(),
      });
      saveCachedSession({ npub, expiresAt, method: "bunker" });
      applyIdentityUpdate(context, { npub, method: "bunker", expiresAt, isAuthenticated: true, alias: npub });
      root.classList.add("is-authenticated");
      setStatus("Connected to remote signer", "success");
      if (nostrConnect) {
        nostrConnect.handleAuthenticated();
        void nostrConnect.reset({ keepSigner: true });
      }
    } catch (error) {
      await disconnectBunkerSigner();
      console.error("[identity] bunker connection failed", error instanceof Error ? error.message : error);
      const hadSecret = Boolean(parsed?.secret && `${parsed.secret}`.length > 0);
      let message = error instanceof Error ? error.message : "Failed to connect to remote signer";

      // Provide more specific error messages for common issues
      if (message.includes("Invalid connection secret")) {
        message = hadSecret
          ? "The secret in your bunker URI is incorrect. Please check the URI and try again."
          : "This bunker expects a secret. Regenerate the URI with a secret or enable secretless connections on the signer.";
      } else if (message.includes("missing secret")) {
        message = "This bunker URI does not include a secret. Wingman supports secretless bunkers; ensure your signer is configured for manual approval.";
      } else if (message.includes("Invalid bunker URI")) {
        message = "The bunker URI format is invalid. Please check the URI starts with 'bunker://' and has all required parameters.";
      }

      setStatus(message, "error");
      root.classList.remove("is-authenticated");
    } finally {
      form?.classList.remove("is-loading");
      enableInputs(true);
    }
  };

  const state = {
    connect: connectWithUri,
  };

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!textarea) return;
    void connectWithUri(textarea.value);
  });

  if (typeof window !== "undefined" && !root.dataset.logoutBunkerHooked) {
    window.addEventListener("wingman:identity-logout", () => {
      setStatus("Signed out", "info");
      root.classList.remove("is-authenticated");
      if (nostrConnect) {
        nostrConnect.handleLogout();
      }
    });
    root.dataset.logoutBunkerHooked = "true";
  }

  const scheduleRestore = () => {
    if (bunkerRestorePromise) return;
    bunkerRestorePromise = attemptBunkerRestore({ context, setStatus, form, enableInputs, root })
      .then((npub) => {
        if (npub && nostrConnect) {
          nostrConnect.handleAuthenticated();
          void nostrConnect.reset({ keepSigner: true });
        }
      })
      .finally(() => {
        bunkerRestorePromise = null;
      });
  };

  scheduleRestore();
  if (nostrConnect && !root.classList.contains("is-authenticated")) {
    void nostrConnect.refreshOffer();
  }

  if (typeof window !== "undefined" && !root.dataset.nostrconnectLoginHooked) {
    const handleLoginOpen = () => {
      nostrConnect?.handleLoginOpen();
    };
    window.addEventListener("wingman:identity-login-open", handleLoginOpen);
    root.dataset.nostrconnectLoginHooked = "true";
  }

  root.__wingmanBunkerState = state;
  root.dataset.bunkerInitialised = "true";
  return state;
};

const wireBunkerPanel = (root, context) => {
  initBunkerPanel(root, context);
};

const wireBunkerLogin = wireBunkerPanel;

identityApi.sessionCache = sessionCache;

identityApi.wireLocalIdentityPanel = wireLocalIdentityPanel;
identityApi.wireNip07Panel = wireNip07Panel;
identityApi.wireNip07 = wireNip07Panel;
identityApi.wireNip07Login = wireNip07Panel;
identityApi.wireBunkerPanel = wireBunkerPanel;
identityApi.wireBunkerLogin = wireBunkerLogin;
identityApi.logoutIdentity = performLogout;
identityApi.bunkerSigner = identityApi.bunkerSigner ?? null;

// =============================================================================
// Key Teleport Support
// =============================================================================

/**
 * Handle Key Teleport v2 login
 *
 * v2 Protocol:
 * - Blob arrives via URL fragment (#keyteleport=) - server never sees it
 * - Blob is self-contained (no callback to Welcome)
 * - Outer layer: encrypted to Wingmen's app key (decrypted server-side)
 * - Inner layer: encrypted with throwaway key (decrypted here with unlock code)
 *
 * @param {Object} options
 * @param {string} options.blob - The base64-encoded Key Teleport blob from URL fragment
 * @param {Object} options.context - The identity context for UI updates
 * @returns {Promise<string|null>} The npub if successful, null otherwise
 */
const handleKeyTeleport = async ({ blob, context }) => {
  if (!blob || typeof blob !== "string") {
    console.error("[KeyTeleport] Missing or invalid blob");
    return null;
  }

  console.log("[KeyTeleport] Processing teleport blob...");

  try {
    // Send blob to backend to decrypt and fetch encryptedNsec + npub
    const response = await fetch("/api/auth/keyteleport", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ blob }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const errorMsg = data?.error ?? `Key teleport failed (${response.status})`;
      console.error("[KeyTeleport]", errorMsg);
      showToast(`Key Teleport failed: ${errorMsg}`, { type: "error" });
      return null;
    }

    // v2 protocol returns encryptedNsec and npub
    const { encryptedNsec, npub: userNpub } = data;
    if (!encryptedNsec || typeof encryptedNsec !== "string") {
      console.error("[KeyTeleport] Invalid encryptedNsec received");
      showToast("Key Teleport failed: Invalid key format received", { type: "error" });
      return null;
    }
    if (!userNpub || typeof userNpub !== "string" || !userNpub.startsWith("npub1")) {
      console.error("[KeyTeleport] Invalid npub received");
      showToast("Key Teleport failed: Invalid public key received", { type: "error" });
      return null;
    }

    console.log("[KeyTeleport] Received encrypted key, prompting for unlock code...");

    // Prompt user to paste the throwaway nsec (unlock code)
    let unlockCode;
    try {
      unlockCode = await promptForUnlockCode({
        title: "Paste Unlock Code",
        message: "Paste the unlock code from your clipboard to complete login",
      });
    } catch (error) {
      if (error instanceof PasswordPromptCancelledError) {
        console.log("[KeyTeleport] User cancelled unlock code prompt");
        return null;
      }
      throw error;
    }

    // Validate and decode the unlock code (throwaway nsec)
    let throwawaySecretKey;
    try {
      const decoded = nip19.decode(unlockCode);
      if (decoded.type !== "nsec") {
        throw new Error("Invalid unlock code format");
      }
      throwawaySecretKey = decoded.data;
    } catch (err) {
      console.error("[KeyTeleport] Failed to decode unlock code:", err);
      showToast("Key Teleport failed: Invalid unlock code", { type: "error" });
      return null;
    }

    // Decode user's public key for conversation key derivation
    let userPubkeyHex;
    try {
      const decodedNpub = nip19.decode(userNpub);
      if (decodedNpub.type !== "npub") {
        throw new Error("Invalid npub format");
      }
      userPubkeyHex = decodedNpub.data;
    } catch (err) {
      console.error("[KeyTeleport] Failed to decode npub:", err);
      showToast("Key Teleport failed: Invalid public key", { type: "error" });
      return null;
    }

    // Decrypt using NIP-44 with throwaway privkey + user pubkey
    let decryptedNsec;
    try {
      const throwawaySecretKeyHex = bytesToHex(throwawaySecretKey);
      const conversationKey = nip44.v2.utils.getConversationKey(throwawaySecretKeyHex, userPubkeyHex);
      decryptedNsec = nip44.v2.decrypt(encryptedNsec, conversationKey);
    } catch (err) {
      console.error("[KeyTeleport] Failed to decrypt:", err);
      showToast("Key Teleport failed: Decryption failed. Wrong unlock code?", { type: "error" });
      return null;
    }

    // Validate and decode the decrypted nsec
    let secretKey;
    try {
      const decoded = nip19.decode(decryptedNsec);
      if (decoded.type !== "nsec") {
        throw new Error("Invalid decrypted key format");
      }
      secretKey = decoded.data;
    } catch (err) {
      console.error("[KeyTeleport] Failed to decode decrypted nsec:", err);
      showToast("Key Teleport failed: Invalid decrypted key", { type: "error" });
      return null;
    }

    // Derive public key and verify it matches
    const publicKeyBytes = schnorr.getPublicKey(secretKey);
    const pubkeyHex = bytesToHex(publicKeyBytes);
    const npub = nip19.npubEncode(pubkeyHex);

    if (npub !== userNpub) {
      console.error("[KeyTeleport] Key mismatch: derived npub doesn't match provided npub");
      showToast("Key Teleport failed: Key verification failed", { type: "error" });
      return null;
    }

    console.log("[KeyTeleport] Key decrypted, creating session...");

    // Store the key in device keystore (Web Crypto + IndexedDB)
    if (deviceKeystore.isAvailable()) {
      try {
        await deviceKeystore.storeNsec(secretKey, { npub, method: "keyteleport" });
        console.log("[KeyTeleport] Key stored in device keystore");
      } catch (error) {
        console.warn("[KeyTeleport] Failed to store key in device keystore:", error instanceof Error ? error.message : error);
      }
    }

    // Create server session
    const { expiresAt } = await persistServerSession(
      npub,
      null,
      (event) => Promise.resolve(finalizeEvent(event, secretKey)),
    );

    // Save session metadata to local cache (no encrypted nsec - that's in device keystore now)
    saveCachedSession({ npub, expiresAt, method: "keyteleport" });

    // Update UI
    applyIdentityUpdate(context, { npub, method: "keyteleport", expiresAt, isAuthenticated: true, alias: npub });

    // Wipe secret keys from memory
    wipeBytes(secretKey);
    wipeBytes(throwawaySecretKey);

    console.log("[KeyTeleport] Login successful:", npub.slice(0, 20) + "...");

    // URL fragment already cleaned at the start of checkKeyTeleportParam

    return npub;
  } catch (error) {
    console.error("[KeyTeleport] Error:", error instanceof Error ? error.message : error);
    showToast(`Key Teleport failed: ${error instanceof Error ? error.message : "Unknown error"}`, {
      type: "error",
    });
    return null;
  }
};

/**
 * Check URL for keyteleport fragment and process if found
 * v2: Uses URL fragment (#keyteleport=) instead of query param
 * Fragment is never sent to server, so blob doesn't appear in logs
 * @param {Object} context - The identity context for UI updates
 */
const checkKeyTeleportParam = async (context) => {
  if (typeof window === "undefined") return null;

  const hash = window.location.hash;
  if (!hash || !hash.includes("keyteleport=")) return null;

  // Parse the fragment as URL parameters (remove leading #)
  const params = new URLSearchParams(hash.slice(1));
  const blob = params.get(KEYTELEPORT_PARAM);

  if (!blob) return null;

  // Clear URL fragment immediately (don't leave blob in browser history)
  if (window.history?.replaceState) {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }

  console.log("[KeyTeleport] Found keyteleport fragment in URL");
  return handleKeyTeleport({ blob: decodeURIComponent(blob), context });
};

identityApi.handleKeyTeleport = handleKeyTeleport;
identityApi.checkKeyTeleportParam = checkKeyTeleportParam;

// =============================================================================
// Device Keystore Auto-Restore
// =============================================================================

/**
 * Attempt to restore session from device keystore
 * Call this on page load to auto-login if nsec is stored
 * @param {Object} context - The identity context for UI updates
 * @returns {Promise<string|null>} The npub if restored, null otherwise
 */
const restoreFromDeviceKeystore = async (context) => {
  if (!deviceKeystore.isAvailable()) {
    return null;
  }

  try {
    const stored = await deviceKeystore.retrieveNsec();
    if (!stored) {
      return null;
    }

    const { nsec, metadata } = stored;
    if (!(nsec instanceof Uint8Array) || nsec.length !== 32) {
      console.warn("[identity] Invalid nsec in device keystore");
      return null;
    }

    // Derive public key and npub
    const publicKeyBytes = schnorr.getPublicKey(nsec);
    const pubkeyHex = bytesToHex(publicKeyBytes);
    const npub = nip19.npubEncode(pubkeyHex);

    // Verify npub matches stored metadata if available
    if (metadata.npub && metadata.npub !== npub) {
      console.warn("[identity] npub mismatch in device keystore, clearing");
      await deviceKeystore.clearNsec();
      return null;
    }

    console.log("[identity] Restoring session from device keystore");

    // Refresh server session
    let expiresAt = null;
    try {
      const result = await persistServerSession(npub, null, (event) => signIdentityEvent(event));
      expiresAt = result.expiresAt;
    } catch (error) {
      console.warn("[identity] Failed to refresh server session:", error instanceof Error ? error.message : error);
      // Continue anyway - the key is still valid locally
    }

    const method = metadata.method ?? "device_keystore";

    // Update session cache
    saveCachedSession({ npub, expiresAt, method });

    // Update UI
    applyIdentityUpdate(context, { npub, method, expiresAt, isAuthenticated: true, alias: npub });

    return npub;
  } catch (error) {
    console.error("[identity] Failed to restore from device keystore:", error instanceof Error ? error.message : error);
    return null;
  }
};

identityApi.restoreFromDeviceKeystore = restoreFromDeviceKeystore;
identityApi.deviceKeystore = deviceKeystore;

globalThis.wingmanIdentity = identityApi;

export {
  PasswordPromptCancelledError,
  sessionCache,
  wireLocalIdentityPanel,
  wireNip07Panel,
  wireBunkerPanel,
  wireBunkerLogin,
  performLogout as logoutIdentity,
  handleKeyTeleport,
  checkKeyTeleportParam,
  restoreFromDeviceKeystore,
  deviceKeystore,
};

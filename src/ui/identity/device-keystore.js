/**
 * Device Keystore - Web Crypto + IndexedDB based secret storage
 *
 * Uses a non-extractable AES-GCM key stored in IndexedDB to encrypt secrets.
 * The key cannot be read by JavaScript (even via XSS), only used for encrypt/decrypt.
 *
 * Storage persists across browser restarts but is lost if browser data is cleared.
 */

const DB_NAME = 'wingman-keystore';
const DB_VERSION = 1;
const KEY_STORE_NAME = 'deviceKeys';
const SECRETS_STORE_NAME = 'secrets';
const DEVICE_KEY_ID = 'primary';

let dbInstance = null;
let deviceKeyCache = null;

/**
 * Open or create the IndexedDB database
 */
function openDatabase() {
  return new Promise((resolve, reject) => {
    if (dbInstance) {
      resolve(dbInstance);
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      reject(new Error('Failed to open keystore database'));
    };

    request.onsuccess = () => {
      dbInstance = request.result;
      resolve(dbInstance);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(KEY_STORE_NAME)) {
        db.createObjectStore(KEY_STORE_NAME, { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains(SECRETS_STORE_NAME)) {
        db.createObjectStore(SECRETS_STORE_NAME, { keyPath: 'id' });
      }
    };
  });
}

/**
 * Get item from an object store
 */
async function getFromStore(storeName, key) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    const request = store.get(key);

    request.onerror = () => reject(new Error(`Failed to read from ${storeName}`));
    request.onsuccess = () => resolve(request.result);
  });
}

/**
 * Put item into an object store
 */
async function putInStore(storeName, item) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    const request = store.put(item);

    request.onerror = () => reject(new Error(`Failed to write to ${storeName}`));
    request.onsuccess = () => resolve();
  });
}

/**
 * Delete item from an object store
 */
async function deleteFromStore(storeName, key) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    const request = store.delete(key);

    request.onerror = () => reject(new Error(`Failed to delete from ${storeName}`));
    request.onsuccess = () => resolve();
  });
}

/**
 * Generate a new non-extractable AES-GCM key
 */
async function generateDeviceKey() {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable - cannot be read by JS
    ['encrypt', 'decrypt']
  );
}

/**
 * Get or create the device encryption key
 * Returns a CryptoKey that cannot be extracted
 */
async function getOrCreateDeviceKey() {
  // Return cached key if available
  if (deviceKeyCache) {
    return deviceKeyCache;
  }

  // Try to load from IndexedDB
  const stored = await getFromStore(KEY_STORE_NAME, DEVICE_KEY_ID);
  if (stored && stored.key) {
    deviceKeyCache = stored.key;
    return deviceKeyCache;
  }

  // Generate new key
  const key = await generateDeviceKey();

  // Store in IndexedDB (CryptoKey objects can be stored via structured cloning)
  await putInStore(KEY_STORE_NAME, {
    id: DEVICE_KEY_ID,
    key,
    createdAt: Date.now(),
  });

  deviceKeyCache = key;
  return key;
}

/**
 * Encrypt data using the device key
 * @param {Uint8Array} plaintext - Data to encrypt
 * @returns {Promise<Uint8Array>} - IV (12 bytes) + ciphertext
 */
async function encrypt(plaintext) {
  const key = await getOrCreateDeviceKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext
  );

  // Concatenate IV + ciphertext
  const result = new Uint8Array(iv.length + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), iv.length);

  return result;
}

/**
 * Decrypt data using the device key
 * @param {Uint8Array} data - IV (12 bytes) + ciphertext
 * @returns {Promise<Uint8Array>} - Decrypted plaintext
 */
async function decrypt(data) {
  if (data.length < 13) {
    throw new Error('Invalid encrypted data: too short');
  }

  const key = await getOrCreateDeviceKey();
  const iv = data.slice(0, 12);
  const ciphertext = data.slice(12);

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );

  return new Uint8Array(plaintext);
}

/**
 * Store an encrypted secret
 * @param {string} id - Secret identifier
 * @param {Uint8Array} secret - Secret data to store
 * @param {Object} metadata - Optional metadata (npub, method, etc.)
 */
async function storeSecret(id, secret, metadata = {}) {
  const encrypted = await encrypt(secret);

  await putInStore(SECRETS_STORE_NAME, {
    id,
    encrypted: Array.from(encrypted), // Convert to array for storage
    ...metadata,
    updatedAt: Date.now(),
  });
}

/**
 * Retrieve and decrypt a secret
 * @param {string} id - Secret identifier
 * @returns {Promise<{secret: Uint8Array, metadata: Object} | null>}
 */
async function retrieveSecret(id) {
  const stored = await getFromStore(SECRETS_STORE_NAME, id);
  if (!stored || !stored.encrypted) {
    return null;
  }

  try {
    const encrypted = new Uint8Array(stored.encrypted);
    const secret = await decrypt(encrypted);

    // Extract metadata (everything except id and encrypted)
    const { id: _id, encrypted: _enc, ...metadata } = stored;

    return { secret, metadata };
  } catch (error) {
    console.error('[device-keystore] Failed to decrypt secret:', error.message);
    return null;
  }
}

/**
 * Check if a secret exists
 * @param {string} id - Secret identifier
 * @returns {Promise<boolean>}
 */
async function hasSecret(id) {
  const stored = await getFromStore(SECRETS_STORE_NAME, id);
  return Boolean(stored && stored.encrypted);
}

/**
 * Delete a secret
 * @param {string} id - Secret identifier
 */
async function deleteSecret(id) {
  await deleteFromStore(SECRETS_STORE_NAME, id);
}

/**
 * Clear all secrets (but keep the device key)
 */
async function clearSecrets() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(SECRETS_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(SECRETS_STORE_NAME);
    const request = store.clear();

    request.onerror = () => reject(new Error('Failed to clear secrets'));
    request.onsuccess = () => resolve();
  });
}

/**
 * Clear everything including the device key (full reset)
 */
async function clearAll() {
  deviceKeyCache = null;
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([KEY_STORE_NAME, SECRETS_STORE_NAME], 'readwrite');

    transaction.onerror = () => reject(new Error('Failed to clear keystore'));
    transaction.oncomplete = () => resolve();

    transaction.objectStore(KEY_STORE_NAME).clear();
    transaction.objectStore(SECRETS_STORE_NAME).clear();
  });
}

/**
 * Check if the keystore is available (Web Crypto + IndexedDB support)
 */
function isAvailable() {
  return (
    typeof crypto !== 'undefined' &&
    typeof crypto.subtle !== 'undefined' &&
    typeof crypto.subtle.generateKey === 'function' &&
    typeof indexedDB !== 'undefined'
  );
}

// Convenience methods for nsec storage
const NSEC_SECRET_ID = 'nostr-nsec';

/**
 * Store the user's nsec encrypted with device key
 * @param {Uint8Array} nsecBytes - 32-byte private key
 * @param {Object} metadata - npub, method, expiresAt, etc.
 */
async function storeNsec(nsecBytes, metadata = {}) {
  if (!(nsecBytes instanceof Uint8Array) || nsecBytes.length !== 32) {
    throw new Error('nsec must be a 32-byte Uint8Array');
  }
  await storeSecret(NSEC_SECRET_ID, nsecBytes, metadata);
}

/**
 * Retrieve the user's nsec
 * @returns {Promise<{nsec: Uint8Array, metadata: Object} | null>}
 */
async function retrieveNsec() {
  const result = await retrieveSecret(NSEC_SECRET_ID);
  if (!result) return null;
  return { nsec: result.secret, metadata: result.metadata };
}

/**
 * Check if nsec is stored
 */
async function hasStoredNsec() {
  return hasSecret(NSEC_SECRET_ID);
}

/**
 * Clear stored nsec
 */
async function clearNsec() {
  await deleteSecret(NSEC_SECRET_ID);
}

export {
  isAvailable,
  encrypt,
  decrypt,
  storeSecret,
  retrieveSecret,
  hasSecret,
  deleteSecret,
  clearSecrets,
  clearAll,
  storeNsec,
  retrieveNsec,
  hasStoredNsec,
  clearNsec,
};

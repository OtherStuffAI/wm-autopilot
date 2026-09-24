import { signIdentityEvent } from '../identity/event-signer.js';

const NIP98_EVENT_KIND = 27235;

function encodeAuthorizationEvent(event) {
  const bytes = new TextEncoder().encode(JSON.stringify(event));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Nostr ${btoa(binary)}`;
}

async function responsePayload(response) {
  return await response.json().catch(() => null);
}

export function connectPackageExpiry(packageValue, maxAgeSeconds = 300) {
  const generatedAt = Date.parse(packageValue?.manifest?.generated_at || '');
  return Number.isFinite(generatedAt) ? generatedAt + maxAgeSeconds * 1000 : null;
}

export function isConnectPackageExpired(packageValue, now = Date.now()) {
  const expiresAt = connectPackageExpiry(packageValue);
  return expiresAt === null || now >= expiresAt;
}

export async function generateAutopilotConnectPackage(ownerNpub) {
  const owner = typeof ownerNpub === 'string' ? ownerNpub.trim() : '';
  if (!owner) throw new Error('Your signed-in owner identity is unavailable.');
  const path = `/api/control-plane/v2/connect-package?owner_npub=${encodeURIComponent(owner)}`;
  const url = new URL(path, globalThis.location.origin).href;
  const signedEvent = await signIdentityEvent({
    kind: NIP98_EVENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['u', url], ['method', 'GET']],
    content: '',
  });
  const response = await fetch(path, {
    method: 'GET',
    credentials: 'include',
    headers: { Authorization: encodeAuthorizationEvent(signedEvent) },
  });
  const payload = await responsePayload(response);
  if (!response.ok) {
    const message = payload?.detail || payload?.error || `Package generation failed (${response.status}).`;
    throw new Error(message);
  }
  if (payload?.manifest?.version !== 2) throw new Error('Autopilot returned an unsupported connect package version.');
  return payload;
}

export async function copyAutopilotConnectPackage(packageValue, clipboard = navigator.clipboard) {
  if (!packageValue || isConnectPackageExpired(packageValue)) {
    throw new Error('This package has expired. Generate a new package before copying.');
  }
  await clipboard.writeText(JSON.stringify(packageValue));
}

import { signIdentityEvent } from "./event-signer.js";

const DEFAULT_CONNECT_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'ws://127.0.0.1:4869',
];

function parseRelayList(input) {
  if (!Array.isArray(input)) return [];
  return Array.from(
    new Set(
      input
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter((value) => value.length > 0),
    ),
  );
}

function resolvePublishRelays(config) {
  const configured = parseRelayList(config?.connectRelays);
  if (configured.length > 0) return configured;
  return [...DEFAULT_CONNECT_RELAYS];
}

async function signDelegateEvent(eventTemplate) {
  return await signIdentityEvent(eventTemplate);
}

async function fetchDelegateRegistryTemplate() {
  const response = await fetch('/api/bot-keys/delegate-registry', { credentials: 'include' });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const message = payload && typeof payload.error === 'string'
      ? payload.error
      : `Failed to fetch delegate registry template (${response.status})`;
    throw new Error(message);
  }

  if (!payload || typeof payload !== 'object' || !payload.eventTemplate) {
    throw new Error('Delegate registry template missing from server response');
  }

  return payload.eventTemplate;
}

async function publishSignedDelegateRegistry(signedEvent, relays) {
  const response = await fetch('/api/bot-keys/delegate-registry/publish', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ signedEvent, relays }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload.error === 'string'
      ? payload.error
      : `Failed to publish delegate registry (${response.status})`;
    throw new Error(message);
  }

  return payload;
}

async function fetchBotProfileStatus(relays) {
  const relayParam = encodeURIComponent(relays.join(','));
  const response = await fetch(`/api/bot-keys/bot-profile/status?relays=${relayParam}`, {
    credentials: 'include',
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload.error === 'string'
      ? payload.error
      : `Failed to fetch bot profile status (${response.status})`;
    throw new Error(message);
  }
  return payload;
}

async function publishBotProfile(relays) {
  const response = await fetch('/api/bot-keys/bot-profile/publish', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ relays }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload.error === 'string'
      ? payload.error
      : `Failed to publish bot kind 0 (${response.status})`;
    throw new Error(message);
  }
  return payload;
}

export async function publishDelegateRegistryForCurrentUser(config) {
  const relays = resolvePublishRelays(config);
  const botProfileStatus = await fetchBotProfileStatus(relays);
  let botProfilePublishResult = null;
  if (!botProfileStatus?.exists) {
    botProfilePublishResult = await publishBotProfile(relays);
  }
  const eventTemplate = await fetchDelegateRegistryTemplate();
  const signedEvent = await signDelegateEvent(eventTemplate);
  const publishResult = await publishSignedDelegateRegistry(signedEvent, relays);
  return {
    ...publishResult,
    signedEvent,
    eventTemplate,
    botProfileStatus,
    botProfilePublishResult,
    botProfileSignedEvent: botProfilePublishResult?.signedEvent ?? null,
  };
}

import { pendingSignRequests } from '../mcp/pending-requests';
import { browserSubscribers } from '../mcp/browser-subscribers';
import type { BrowserSignedNip98TokenRequest } from './types';

const NIP98_KIND = 27235;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return bytesToHex(new Uint8Array(digest));
}

export async function requestBrowserNip98Token(
  request: BrowserSignedNip98TokenRequest,
): Promise<string> {
  if (!browserSubscribers.hasSubscriber(request.npub)) {
    throw new Error('No active browser signer for this user. Open the Wingmen UI and keep it signed in.');
  }

  const tags: string[][] = [
    ['u', request.url],
    ['method', request.method.toUpperCase()],
  ];
  if (request.body !== undefined && request.body !== null) {
    const jsonBody = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
    tags.push(['payload', await sha256Hex(jsonBody)]);
  }

  const { requestId, promise } = pendingSignRequests.create(request.npub);
  const delivered = browserSubscribers.send(request.npub, {
    type: 'nip98:sign_request',
    requestId,
    eventTemplate: {
      kind: NIP98_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: '',
    },
  });
  if (!delivered) {
    pendingSignRequests.reject(requestId, 'Failed to deliver NIP-98 signing request to the browser.');
    throw new Error('Browser signer disconnected before the request was delivered.');
  }

  const signedEvent = await promise;
  return `Nostr ${btoa(JSON.stringify(signedEvent))}`;
}

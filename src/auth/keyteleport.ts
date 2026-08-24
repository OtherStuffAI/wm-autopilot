/**
 * Key Teleport v2 route handler
 * Handles secure key import from Welcome (trusted key manager) via NIP-44 encrypted payloads
 *
 * Protocol v2: Self-contained blobs with double encryption
 * - Outer layer: NIP-44 encrypted from Welcome → Wingmen (decrypted server-side)
 * - Inner layer: NIP-44 encrypted from user → throwaway key (decrypted client-side with unlock code)
 * - Blob arrives via URL fragment (#keyteleport=) so server never sees it in logs
 * - No server callback required - blob contains everything needed
 */

import { nip44, verifyEvent, finalizeEvent } from "nostr-tools";
import { getKeyTeleportIdentity, getKeyTeleportWelcomePubkey } from "../config";

interface KeyTeleportRequest {
  blob: string;
}

/**
 * v2 payload structure (self-contained in the blob)
 * - encryptedNsec: NIP-44 encrypted nsec (inner layer, decrypted client-side with throwaway key)
 * - npub: User's public key (for deriving conversation key with throwaway)
 * - v: Protocol version (must be 1)
 */
interface KeyTeleportPayload {
  encryptedNsec: string;
  npub: string;
  v: number;
}

/**
 * Handle POST /api/auth/keyteleport
 *
 * v2 Protocol (self-contained blobs):
 * 1. Receive base64 blob from client (extracted from URL fragment)
 * 2. Verify the signature is from the trusted Welcome pubkey
 * 3. Decrypt outer layer with Wingmen's app key
 * 4. Return encryptedNsec and npub to client for client-side decryption
 *
 * No server callback required - the blob contains everything needed.
 */
export async function handleKeyTeleport(request: Request): Promise<Response> {
  // Check if Key Teleport is configured
  const identity = getKeyTeleportIdentity();
  const welcomePubkey = getKeyTeleportWelcomePubkey();

  if (!identity || !welcomePubkey) {
    return Response.json({ error: "Key Teleport not configured" }, { status: 503 });
  }

  // Parse request body
  let body: KeyTeleportRequest | null;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as KeyTeleportRequest
      : null;
  } catch {
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  if (!body?.blob) {
    return Response.json({ error: "Missing blob parameter" }, { status: 400 });
  }

  try {
    // The blob is a base64-encoded signed Nostr event with NIP-44 encrypted content
    // Decode the base64 blob to get the event JSON
    let eventJson: string;
    try {
      eventJson = atob(body.blob);
    } catch {
      return Response.json({ error: "Invalid blob encoding" }, { status: 400 });
    }

    // Parse the signed event
    let signedEvent: {
      pubkey: string;
      content: string;
      sig: string;
      id: string;
      kind: number;
      created_at: number;
      tags: string[][];
    };
    try {
      signedEvent = JSON.parse(eventJson);
    } catch {
      return Response.json({ error: "Invalid event format" }, { status: 400 });
    }

    // Verify the event signature
    if (!verifyEvent(signedEvent)) {
      return Response.json({ error: "Invalid event signature" }, { status: 400 });
    }

    // Verify the event is from the trusted Welcome pubkey
    if (signedEvent.pubkey !== welcomePubkey) {
      console.error(`[KeyTeleport] Event from untrusted pubkey: ${signedEvent.pubkey.slice(0, 16)}...`);
      return Response.json({ error: "Untrusted source" }, { status: 403 });
    }

    // Decrypt the event content using NIP-44 (outer layer)
    // Uses Wingmen's app key + Welcome's pubkey
    const conversationKey = nip44.v2.utils.getConversationKey(identity.secretKey, signedEvent.pubkey);

    let decryptedContent: string;
    try {
      decryptedContent = nip44.v2.decrypt(signedEvent.content, conversationKey);
    } catch (err) {
      console.error("[KeyTeleport] Failed to decrypt outer layer:", err);
      return Response.json({ error: "Decryption failed - blob not for this app" }, { status: 400 });
    }

    // Parse the decrypted payload (v2 self-contained format)
    let payload: KeyTeleportPayload;
    try {
      payload = JSON.parse(decryptedContent);
    } catch {
      return Response.json({ error: "Invalid payload format" }, { status: 400 });
    }

    // Validate v2 protocol version
    if (payload.v !== 1) {
      console.error(`[KeyTeleport] Unsupported protocol version: ${payload.v}`);
      return Response.json({ error: `Unsupported protocol version: ${payload.v}` }, { status: 400 });
    }

    // Validate required fields (v2 self-contained payload)
    if (!payload.encryptedNsec || typeof payload.encryptedNsec !== "string") {
      return Response.json({ error: "Missing encryptedNsec in payload" }, { status: 400 });
    }

    if (!payload.npub || typeof payload.npub !== "string") {
      return Response.json({ error: "Missing npub in payload" }, { status: 400 });
    }

    // Validate npub format
    if (!payload.npub.startsWith("npub1")) {
      return Response.json({ error: "Invalid npub format" }, { status: 400 });
    }

    console.log("[KeyTeleport] Successfully decrypted outer layer, returning payload for client-side decryption");

    // Return encryptedNsec and npub to client for client-side inner layer decryption
    // Client will use the unlock code (throwaway nsec from clipboard) to decrypt
    return Response.json({
      encryptedNsec: payload.encryptedNsec,
      npub: payload.npub
    });
  } catch (err) {
    console.error("[KeyTeleport] Unexpected error:", err);
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}

/**
 * Generate a registration blob for registering Wingmen with Welcome
 *
 * The blob is a signed Nostr event with plaintext content:
 * - kind: 30078
 * - tags: [["type", "keyteleport-app-registration"]]
 * - content: JSON with {url, name, description}
 *
 * User copies this blob and pastes into Welcome to register Wingmen as a receiving app.
 */
export function generateRegistrationBlob(appUrl: string, appName: string, appDescription: string): string | null {
  const identity = getKeyTeleportIdentity();
  if (!identity) {
    return null;
  }

  const content = JSON.stringify({
    url: appUrl,
    name: appName,
    description: appDescription,
    metadata: {},
  });

  const event = finalizeEvent({
    kind: 30078,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["type", "keyteleport-app-registration"]],
    content,
  }, identity.secretKey);

  return btoa(JSON.stringify(event));
}

/**
 * Handle GET /api/auth/keyteleport/registration
 * Returns a registration blob for the user to paste into Welcome
 */
export async function handleKeyTeleportRegistration(request: Request): Promise<Response> {
  const identity = getKeyTeleportIdentity();
  if (!identity) {
    return Response.json({ error: "Key Teleport not configured" }, { status: 503 });
  }

  const url = new URL(request.url);
  const appUrl = url.searchParams.get("url") ?? url.origin;
  const appName = url.searchParams.get("name") ?? "Wingman";
  const appDescription = url.searchParams.get("description") ?? "AI Agent Orchestration Platform";

  const blob = generateRegistrationBlob(appUrl, appName, appDescription);
  if (!blob) {
    return Response.json({ error: "Failed to generate registration blob" }, { status: 500 });
  }

  return Response.json({
    blob,
    appNpub: identity.npub,
    appPubkey: identity.pubkey,
    url: appUrl,
    name: appName,
    description: appDescription,
  });
}

/**
 * Tier 1 NIP-98 signer — signs HTTP auth events using the shared Wingman
 * instance identity configured with WINGMAN_PRIV.
 *
 * Creates kind 27235 events per the NIP-98 spec:
 *   https://github.com/nostr-protocol/nips/blob/master/98.md
 */

import { finalizeEvent } from "nostr-tools";
import { loadWingmanInstanceIdentity, type WingmanInstanceIdentity } from "../identity/wingman-instance-identity";
import type { SignNip98Response } from "./types";

/** NIP-98 HTTP Auth event kind. */
const NIP98_KIND = 27235;

/**
 * Build and sign a NIP-98 token with the given secret key.
 */
function buildNip98Token(
  url: string,
  method: string,
  secretKey: Uint8Array,
  npub: string,
  bodyHash?: string,
): SignNip98Response {
  const tags: string[][] = [
    ["u", url],
    ["method", method.toUpperCase()],
  ];

  if (bodyHash) {
    tags.push(["payload", bodyHash]);
  }

  const template = {
    kind: NIP98_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: "",
  };

  const signedEvent = finalizeEvent(template, secretKey);

  const eventJson = JSON.stringify(signedEvent);
  const base64Token = btoa(eventJson);
  const token = `Nostr ${base64Token}`;

  return { token, signedBy: npub };
}

/**
 * Sign a NIP-98 token with the Wingman instance key.
 *
 * @throws If WINGMAN_PRIV is not configured.
 */
export async function signWithWingmanKey(
  url: string,
  method: string,
  bodyHash?: string,
): Promise<SignNip98Response> {
  const identity = loadWingmanInstanceIdentity();
  if (!identity) {
    throw new Error(
      "Wingman instance key not configured. Set WINGMAN_PRIV to enable Tier 1 NIP-98 signing.",
    );
  }

  return buildNip98Token(url, method, identity.secretKey, identity.npub, bodyHash);
}

export function signWithWingmanIdentity(
  identity: WingmanInstanceIdentity,
  url: string,
  method: string,
  bodyHash?: string,
): SignNip98Response {
  return buildNip98Token(url, method, identity.secretKey, identity.npub, bodyHash);
}

/**
 * Sign a NIP-98 token with a user's bot key.
 *
 * @throws If the provided secret key is invalid.
 */
export function signWithBotKey(
  url: string,
  method: string,
  secretKey: Uint8Array,
  npub: string,
  bodyHash?: string,
): SignNip98Response {
  return buildNip98Token(url, method, secretKey, npub, bodyHash);
}

export interface SignForSessionResult extends SignNip98Response {
  signerType: "wingman";
}

/**
 * Sign a NIP-98 token for a session. The user npub is retained for call-site
 * compatibility and audit context, but the signer is always the instance key.
 *
 * @param url - Target URL for the NIP-98 token
 * @param method - HTTP method
 * @param userNpub - User's npub retained for audit-oriented call sites.
 * @param bodyHash - SHA-256 hash of the request body (optional)
 */
export async function signForSession(
  url: string,
  method: string,
  userNpub?: string | null,
  bodyHash?: string,
): Promise<SignForSessionResult> {
  void userNpub;
  const result = await signWithWingmanKey(url, method, bodyHash);
  return { ...result, signerType: "wingman" };
}

/**
 * Check whether the Wingman instance key is available for Tier 1 signing.
 */
export function isWingmanKeyAvailable(): boolean {
  return loadWingmanInstanceIdentity() !== null;
}

/**
 * NIP-44 Utilities for MCP Tools
 *
 * Resolves the shared Wingman bot identity from environment variables.
 * Runs in the MCP child process; server-only private keys are stripped.
 */

/**
 * Get the bot key pubkey from env vars. Returns null if not configured.
 */
export function getBotPubkey(): string | null {
  return process.env.BOT_PUBKEY_HEX ?? null;
}

/**
 * Get the bot key npub from env vars. Returns null if not configured.
 */
export function getBotNpub(): string | null {
  return process.env.BOT_NPUB ?? null;
}

export function getWingmanNpub(): string | null {
  return process.env.WINGMAN_NPUB ?? process.env.BOT_NPUB ?? null;
}

/**
 * Get the user's npub from env vars. Returns null if not configured.
 */
export function getUserNpub(): string | null {
  return process.env.USER_NPUB ?? null;
}

/**
 * Identity preamble for NIP-44 tool responses.
 * Reminds the agent which pubkey is its shared Wingman identity.
 */
export function wingmanIdentityPreamble(): string {
  const pubkey = getBotPubkey();
  if (!pubkey) return "";
  return `[Wingman instance identity: ${pubkey}]\n\n`;
}

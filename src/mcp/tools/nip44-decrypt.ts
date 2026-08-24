/**
 * MCP Tool: nip44_decrypt
 *
 * Decrypt a NIP-44 v2 ciphertext from a sender pubkey.
 * Routes through the capability broker so the stable agent key never leaves
 * the protected server boundary.
 */

import { z } from "zod";
import { callCapabilityBroker } from "../capability-client";

export const nip44DecryptSchema = {
  ciphertext: z
    .string()
    .describe("Base64-encoded NIP-44 ciphertext to decrypt"),
  sender_pubkey: z
    .string()
    .describe("Sender's public key (64-char hex) — needed to derive the shared secret"),
};

export const nip44DecryptDescription =
  "Decrypt a NIP-44 v2 encrypted payload using this session's stable agent identity. " +
  "Requires the sender's pubkey to derive the conversation key. " +
  "Returns the decrypted plaintext.";

interface Nip44DecryptParams {
  ciphertext: string;
  sender_pubkey: string;
}

async function brokerDecrypt(
  params: Nip44DecryptParams,
): Promise<{ plaintext: string; decryptedBy: string } | null> {
  try {
    return await callCapabilityBroker<{ plaintext: string; decryptedBy: string }>(
      "/api/mcp/capabilities/nip44/decrypt",
      { ciphertext: params.ciphertext, senderPubkey: params.sender_pubkey },
    );
  } catch {
    return null;
  }
}

export async function handleNip44Decrypt(params: Nip44DecryptParams) {
  try {
    if (!/^[0-9a-fA-F]{64}$/.test(params.sender_pubkey)) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: "sender_pubkey must be a 64-character hex string.",
          },
        ],
      };
    }

    const botResult = await brokerDecrypt(params);
    if (botResult) {
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Decrypted by ${botResult.decryptedBy} (stable agent identity)`,
              `Sender: ${params.sender_pubkey}`,
              "",
              botResult.plaintext,
            ].join("\n"),
          },
        ],
      };
    }

    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: "NIP-44 decryption failed: request a scoped agent capability; do not search for a private key.",
        },
      ],
    };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `NIP-44 decryption failed: ${(err as Error).message}`,
        },
      ],
    };
  }
}

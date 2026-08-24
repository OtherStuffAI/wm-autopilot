/**
 * MCP Tool: nip44_encrypt
 *
 * Encrypt plaintext to a recipient pubkey using NIP-44 v2.
 * Routes through the capability broker so the stable agent key never leaves
 * the protected server boundary.
 */

import { z } from "zod";
import { callCapabilityBroker } from "../capability-client";

export const nip44EncryptSchema = {
  plaintext: z
    .string()
    .describe("The plaintext content to encrypt"),
  recipient_pubkey: z
    .string()
    .describe("Recipient's public key (64-char hex)"),
};

export const nip44EncryptDescription =
  "Encrypt plaintext to a recipient pubkey using NIP-44 v2. " +
  "Uses this session's stable agent identity as the sender. " +
  "Returns base64-encoded ciphertext that only the recipient can decrypt.";

interface Nip44EncryptParams {
  plaintext: string;
  recipient_pubkey: string;
}

async function brokerEncrypt(
  params: Nip44EncryptParams,
): Promise<{ ciphertext: string; senderPubkey: string } | null> {
  try {
    return await callCapabilityBroker<{ ciphertext: string; senderPubkey: string }>(
      "/api/mcp/capabilities/nip44/encrypt",
      { plaintext: params.plaintext, recipientPubkey: params.recipient_pubkey },
    );
  } catch {
    return null;
  }
}

export async function handleNip44Encrypt(params: Nip44EncryptParams) {
  try {
    if (!/^[0-9a-fA-F]{64}$/.test(params.recipient_pubkey)) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: "recipient_pubkey must be a 64-character hex string.",
          },
        ],
      };
    }

    const botResult = await brokerEncrypt(params);
    if (botResult) {
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Encrypted by ${botResult.senderPubkey} (stable agent identity)`,
              `Recipient: ${params.recipient_pubkey}`,
              "",
              botResult.ciphertext,
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
          text: "NIP-44 encryption failed: request a scoped agent capability; do not search for a private key.",
        },
      ],
    };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `NIP-44 encryption failed: ${(err as Error).message}`,
        },
      ],
    };
  }
}

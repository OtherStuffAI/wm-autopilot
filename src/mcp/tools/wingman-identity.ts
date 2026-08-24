/**
 * MCP Tool: get_wingman_identity
 *
 * Returns the shared Wingman bot public identity (hex and npub).
 */

import { readCapabilityIdentity } from "../capability-client";

export const wingmanIdentitySchema = {};

export const wingmanIdentityDescription =
  "Get this session's stable agent public identity (hex pubkey and npub).";

export async function handleGetWingmanIdentity() {
  try {
    const { botPubkeyHex, botNpub } = await readCapabilityIdentity();
    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Stable agent identity:`,
            `  hexpub: ${botPubkeyHex}`,
            `  npub:   ${botNpub}`,
            ``,
            `This identity is bound to the session capability and is distinct from the Wingman instance and human identities.`,
          ].join("\n"),
        },
      ],
    };
  } catch (error) {
    return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: `Stable agent identity unavailable: ${(error as Error).message}`,
      },
    ],
    };
  }
}

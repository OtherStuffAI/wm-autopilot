#!/usr/bin/env bun

import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

import { callCapabilityBroker, readCapabilityIdentity } from "../src/mcp/capability-client";
import { uploadBlossomObject } from "../src/mcp/blossom-client";

function usage(exitCode = 1): never {
  console.log(`Wingman capability client

Uses WINGMAN_URL, SESSION_ID and WINGMAN_CAPABILITY from the session environment.
Never put a capability token on a command line or in chat.

Commands:
  identity
  nip98 --url <url> --method <method> [--body-file <path>] [--tags-json <json>]
  event --kind <kind> [--content <text>] [--tags-json <json>]
  encrypt --peer <hex-pubkey> --text <plaintext>
  decrypt --peer <hex-pubkey> --ciphertext <value>
  blossom-auth --server <url> --method <upload|delete|list> --hash <sha256> --size <bytes>
  blossom-upload --server <url> --file <path> [--content-type <mime>]
  wallet --method <read-method> [--params-json <json>]

Direct NAK --sec/NOSTR_SECRET_KEY use is intentionally unsupported. The event
output is NAK-compatible and can be piped to 'nak verify'.`);
  process.exit(exitCode);
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function required(args: string[], name: string): string {
  const value = flag(args, name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function jsonFlag(args: string[], name: string, fallback: unknown): unknown {
  const value = flag(args, name);
  return value === undefined ? fallback : JSON.parse(value);
}

async function run(): Promise<void> {
  const [command, ...args] = Bun.argv.slice(2);
  if (!command || command === "--help" || command === "-h") usage(command ? 0 : 1);

  if (command === "identity") {
    console.log(JSON.stringify(await readCapabilityIdentity(), null, 2));
    return;
  }
  if (command === "nip98") {
    const bodyFile = flag(args, "--body-file");
    const bodyHash = bodyFile
      ? bytesToHex(sha256(new Uint8Array(await Bun.file(bodyFile).arrayBuffer())))
      : undefined;
    const result = await callCapabilityBroker<{ token: string; signedBy: string }>(
      "/api/mcp/capabilities/nip98",
      {
        url: required(args, "--url"),
        method: required(args, "--method"),
        bodyHash,
        tags: jsonFlag(args, "--tags-json", []),
      },
    );
    console.log(JSON.stringify({ authorization: result.token, signedBy: result.signedBy }, null, 2));
    return;
  }
  if (command === "event") {
    const result = await callCapabilityBroker<{ event: unknown }>(
      "/api/mcp/capabilities/nostr-event",
      { event: {
        kind: Number(required(args, "--kind")),
        content: flag(args, "--content") ?? "",
        tags: jsonFlag(args, "--tags-json", []),
      } },
    );
    console.log(JSON.stringify(result.event));
    return;
  }
  if (command === "encrypt") {
    console.log(JSON.stringify(await callCapabilityBroker(
      "/api/mcp/capabilities/nip44/encrypt",
      { recipientPubkey: required(args, "--peer"), plaintext: required(args, "--text") },
    ), null, 2));
    return;
  }
  if (command === "decrypt") {
    console.log(JSON.stringify(await callCapabilityBroker(
      "/api/mcp/capabilities/nip44/decrypt",
      { senderPubkey: required(args, "--peer"), ciphertext: required(args, "--ciphertext") },
    ), null, 2));
    return;
  }
  if (command === "blossom-auth") {
    console.log(JSON.stringify(await callCapabilityBroker(
      "/api/mcp/capabilities/blossom/authorize",
      {
        server: required(args, "--server"),
        method: required(args, "--method"),
        objectHash: required(args, "--hash"),
        objectSize: Number(required(args, "--size")),
      },
    ), null, 2));
    return;
  }
  if (command === "blossom-upload") {
    const file = Bun.file(required(args, "--file"));
    if (!await file.exists()) throw new Error("--file does not exist");
    const result = await uploadBlossomObject({
      server: required(args, "--server"),
      bytes: new Uint8Array(await file.arrayBuffer()),
      contentType: flag(args, "--content-type") ?? file.type,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "wallet") {
    console.log(JSON.stringify(await callCapabilityBroker(
      "/api/mcp/capabilities/wallet",
      { method: required(args, "--method"), params: jsonFlag(args, "--params-json", {}) },
    ), null, 2));
    return;
  }
  usage();
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

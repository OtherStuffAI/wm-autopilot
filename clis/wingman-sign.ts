#!/usr/bin/env bun

import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

import {
  mintSigningCapabilityToken,
  type Nip98SigningCapability,
  type NostrSigningCapability,
} from "../src/signing/capability-token";

function usage(exitCode = 1): never {
  console.log(`Wingman signing CLI

Usage:
  bun clis/wingman-sign.ts mint --ttl-seconds <n> [--session-id <id>] [--nip98-host <host> ...] [--nip98-method <method> ...] [--nip98-path-prefix <path> ...] [--nostr-kind <kind> ...]
  bun clis/wingman-sign.ts nip98 --url <url> --method <method> [--session-id <id>] [--body-file <path> | --body-hash <hex>] [--out header|token|json]
  bun clis/wingman-sign.ts nostr-event --kind <kind> [--session-id <id>] [--content <text> | --content-file <path>] [--tags-json <json> | --tags-file <path>]

Environment:
  WINGMAN_SIGNING_SECRET  Required for mint.
  WINGMAN_SIGNING_TOKEN   Required for nip98 and nostr-event.
  WINGMAN_URL             Optional Wingman base URL, defaults to http://127.0.0.1:$PORT or :3600.
`);
  process.exit(exitCode);
}

function flagValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

function flagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) {
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      continue;
    }
    values.push(value);
  }
  return values;
}

function requireFlag(args: string[], flag: string): string {
  const value = flagValue(args, flag);
  if (!value) {
    throw new Error(`${flag} is required`);
  }
  return value;
}

function parsePositiveInteger(input: string, name: string): number {
  const value = Number(input);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parseNonNegativeInteger(input: string, name: string): number {
  const value = Number(input);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function resolveBaseUrl(args: string[]): string {
  const explicit = flagValue(args, "--base-url") ?? Bun.env.WINGMAN_URL ?? "";
  if (explicit.trim()) {
    return explicit.replace(/\/+$/, "");
  }
  return `http://127.0.0.1:${Bun.env.PORT || "3600"}`;
}

function resolveSigningToken(): string {
  const token = Bun.env.WINGMAN_SIGNING_TOKEN?.trim();
  if (!token) {
    throw new Error("WINGMAN_SIGNING_TOKEN is required");
  }
  return token;
}

async function readTextFile(path: string): Promise<string> {
  return await Bun.file(path).text();
}

async function resolveBodyHash(args: string[]): Promise<string | undefined> {
  const explicitHash = flagValue(args, "--body-hash");
  if (explicitHash) {
    if (!/^[0-9a-fA-F]{64}$/.test(explicitHash)) {
      throw new Error("--body-hash must be a 64-character hex SHA-256 digest");
    }
    return explicitHash.toLowerCase();
  }

  const bodyFile = flagValue(args, "--body-file");
  if (!bodyFile) {
    return undefined;
  }
  const bytes = await Bun.file(bodyFile).arrayBuffer();
  return bytesToHex(sha256(new Uint8Array(bytes)));
}

async function postJson(baseUrl: string, path: string, token: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) as unknown : null;
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload
      ? String((payload as { error: unknown }).error)
      : response.statusText;
    throw new Error(`Signing request failed (${response.status}): ${message}`);
  }
  return payload;
}

async function handleMint(args: string[]): Promise<void> {
  const secret = Bun.env.WINGMAN_SIGNING_SECRET?.trim();
  if (!secret) {
    throw new Error("WINGMAN_SIGNING_SECRET is required for mint");
  }

  const ttlSeconds = parsePositiveInteger(requireFlag(args, "--ttl-seconds"), "--ttl-seconds");
  const nip98Hosts = flagValues(args, "--nip98-host");
  const nip98Urls = flagValues(args, "--nip98-url");
  const nip98Methods = flagValues(args, "--nip98-method");
  const nip98PathPrefixes = flagValues(args, "--nip98-path-prefix");
  const nostrKinds = flagValues(args, "--nostr-kind").map((kind) => parseNonNegativeInteger(kind, "--nostr-kind"));

  const nip98: Nip98SigningCapability | undefined =
    nip98Hosts.length > 0 || nip98Urls.length > 0 || nip98Methods.length > 0 || nip98PathPrefixes.length > 0
      ? { hosts: nip98Hosts, urls: nip98Urls, methods: nip98Methods, pathPrefixes: nip98PathPrefixes }
      : undefined;
  const nostr: NostrSigningCapability | undefined = nostrKinds.length > 0 ? { kinds: nostrKinds } : undefined;
  if (!nip98 && !nostr) {
    throw new Error("Mint requires at least one --nip98-host, --nip98-url, or --nostr-kind capability");
  }

  console.log(mintSigningCapabilityToken(secret, {
    ttlSeconds,
    sessionId: flagValue(args, "--session-id") ?? undefined,
    nip98,
    nostr,
  }));
}

async function handleNip98(args: string[]): Promise<void> {
  const url = requireFlag(args, "--url");
  const method = requireFlag(args, "--method").toUpperCase();
  const sessionId = flagValue(args, "--session-id") ?? Bun.env.SESSION_ID ?? undefined;
  const result = await postJson(resolveBaseUrl(args), "/api/internal/signing/nip98", resolveSigningToken(), {
    sessionId,
    url,
    method,
    bodyHash: await resolveBodyHash(args),
  }) as { token: string; signedBy: string };

  const out = flagValue(args, "--out") ?? "header";
  if (out === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else if (out === "token") {
    console.log(result.token);
  } else {
    console.log(`Authorization: ${result.token}`);
  }
}

function parseTags(value: unknown): string[][] {
  if (!Array.isArray(value)) {
    throw new Error("tags must be an array");
  }
  for (const entry of value) {
    if (!Array.isArray(entry) || !entry.every((item) => typeof item === "string")) {
      throw new Error("tags must be an array of string arrays");
    }
  }
  return value as string[][];
}

async function resolveTags(args: string[]): Promise<string[][]> {
  const tagsFile = flagValue(args, "--tags-file");
  const tagsJson = tagsFile ? await readTextFile(tagsFile) : flagValue(args, "--tags-json");
  if (!tagsJson) {
    return [];
  }
  return parseTags(JSON.parse(tagsJson));
}

async function resolveContent(args: string[]): Promise<string> {
  const contentFile = flagValue(args, "--content-file");
  if (contentFile) {
    return await readTextFile(contentFile);
  }
  return flagValue(args, "--content") ?? "";
}

async function handleNostrEvent(args: string[]): Promise<void> {
  const kind = parseNonNegativeInteger(requireFlag(args, "--kind"), "--kind");
  const sessionId = flagValue(args, "--session-id") ?? Bun.env.SESSION_ID ?? undefined;
  const result = await postJson(resolveBaseUrl(args), "/api/internal/signing/nostr-event", resolveSigningToken(), {
    sessionId,
    event: {
      kind,
      content: await resolveContent(args),
      tags: await resolveTags(args),
    },
  });
  console.log(JSON.stringify(result, null, 2));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command) {
    usage(1);
  }
  if (command === "--help" || command === "-h" || command === "help") {
    usage(0);
  }

  if (command === "mint") {
    await handleMint(args.slice(1));
    return;
  }
  if (command === "nip98") {
    await handleNip98(args.slice(1));
    return;
  }
  if (command === "nostr-event") {
    await handleNostrEvent(args.slice(1));
    return;
  }
  usage(1);
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});

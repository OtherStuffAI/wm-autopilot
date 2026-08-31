/**
 * Shared NIP-98 authentication library for Wingman CLIs.
 *
 * Handles secret key resolution, NIP-98 header construction,
 * and authenticated JSON requests against the Wingman HTTP API.
 */

import { finalizeEvent, nip19 } from "nostr-tools";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { callCapabilityBroker } from "../../src/mcp/capability-client";

const NIP98_KIND = 27235;

export interface CliConfig {
  baseUrl: string;
  secretKey: Uint8Array;
}

export interface BotCryptoConfig {
  baseUrl: string;
  brokerUrl: string;
  botCrypto: true;
}

/**
 * Resolve a signing key from CLI flag, env vars, or throw.
 * Operator-only recovery path. Agent sessions must use the capability broker.
 * Priority: keyInput arg → WINGMAN_NSEC
 */
export function resolveSecretKey(keyInput?: string): Uint8Array {
  const raw = (
    keyInput ??
    Bun.env.WINGMAN_NSEC ??
    ""
  ).trim();

  if (!raw) {
    throw new Error(
      "Missing operator signing key. Agent sessions must use --bot-crypto (capability broker); operators may provide --key or WINGMAN_NSEC.",
    );
  }

  if (raw.startsWith("nsec1")) {
    const decoded = nip19.decode(raw);
    if (decoded.type !== "nsec" || !(decoded.data instanceof Uint8Array)) {
      throw new Error("Invalid nsec key");
    }
    return decoded.data;
  }

  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return hexToBytes(raw);
  }

  throw new Error("Signing key must be nsec or 64-char hex");
}

export type CliAuthConfig = CliConfig | BotCryptoConfig;

/**
 * Build a NIP-98 Authorization header value.
 */
export function buildAuthHeader(
  url: string,
  method: string,
  secretKey: Uint8Array,
  body?: unknown,
): string {
  const upperMethod = method.toUpperCase();
  const tags: string[][] = [
    ["u", url],
    ["method", upperMethod],
  ];

  if (body !== undefined && body !== null) {
    const bodyBytes = new TextEncoder().encode(JSON.stringify(body));
    tags.push(["payload", bytesToHex(sha256(bodyBytes))]);
  }

  const event = finalizeEvent(
    {
      kind: NIP98_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: "",
    },
    secretKey,
  );

  const token = Buffer.from(JSON.stringify(event), "utf8").toString("base64");
  return `Nostr ${token}`;
}

/**
 * Build a NIP-98 Authorization header through the scoped capability broker.
 */
export async function buildBotCryptoAuthHeader(
  brokerUrl: string,
  url: string,
  method: string,
  body?: unknown,
): Promise<string> {
  let bodyHash: string | undefined;
  if (body !== undefined && body !== null) {
    const bodyBytes = new TextEncoder().encode(JSON.stringify(body));
    bodyHash = bytesToHex(sha256(bodyBytes));
  }

  const sessionId = Bun.env.SESSION_ID;
  if (!sessionId) {
    throw new Error("--bot-crypto requires SESSION_ID from an agent session");
  }
  const result = await callCapabilityBroker<{ token: string }>(
    "/api/mcp/capabilities/nip98",
    { url, method, bodyHash },
    { wingmanUrl: brokerUrl, sessionId, capabilityToken: Bun.env.WINGMAN_CAPABILITY ?? "" },
  );
  return result.token;
}

/**
 * Make an authenticated JSON request to the Wingman API.
 */
export async function requestJson<T>(
  baseUrl: string,
  secretKey: Uint8Array,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = new URL(path, baseUrl).toString();
  const authorization = buildAuthHeader(url, method, secretKey, body);

  const response = await fetch(url, {
    method,
    headers: {
      authorization,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const rawText = await response.text();
  let payload: unknown = {};
  if (rawText.length > 0) {
    try {
      payload = JSON.parse(rawText);
    } catch {
      payload = { error: rawText };
    }
  }

  if (!response.ok) {
    const message =
      typeof (payload as { error?: unknown })?.error === "string"
        ? (payload as { error: string }).error
        : response.statusText || "Request failed";
    throw new Error(`${response.status} ${message}`);
  }

  return payload as T;
}

/**
 * Make an authenticated JSON request using bot-crypto signing.
 */
export async function requestJsonBotCrypto<T>(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  brokerUrl = resolveCapabilityBrokerUrl(baseUrl),
  signingBaseUrl = baseUrl,
): Promise<T> {
  const url = new URL(path, baseUrl).toString();
  const signingUrl = new URL(path, signingBaseUrl).toString();
  const authorization = await buildBotCryptoAuthHeader(brokerUrl, signingUrl, method, body);

  const response = await fetch(url, {
    method,
    headers: {
      authorization,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const rawText = await response.text();
  let payload: unknown = {};
  if (rawText.length > 0) {
    try {
      payload = JSON.parse(rawText);
    } catch {
      payload = { error: rawText };
    }
  }

  if (!response.ok) {
    const message =
      typeof (payload as { error?: unknown })?.error === "string"
        ? (payload as { error: string }).error
        : response.statusText || "Request failed";
    throw new Error(`${response.status} ${message}`);
  }

  return payload as T;
}

export function buildAuthConfig(urlInput?: string, keyInput?: string, botCrypto = false): CliAuthConfig {
  const baseUrl = resolveBaseUrl(urlInput);
  if (botCrypto) {
    if (keyInput) throw new Error("--bot-crypto cannot be combined with --key");
    if (!Bun.env.SESSION_ID || !Bun.env.WINGMAN_CAPABILITY) {
      throw new Error("--bot-crypto requires brokered SESSION_ID and WINGMAN_CAPABILITY context");
    }
    return { baseUrl, brokerUrl: resolveCapabilityBrokerUrl(baseUrl), botCrypto: true };
  }
  return { baseUrl, secretKey: resolveSecretKey(keyInput) };
}

export function requestJsonWithAuth<T>(
  config: CliAuthConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  return "botCrypto" in config
    ? requestJsonBotCrypto<T>(config.baseUrl, method, path, body, config.brokerUrl)
    : requestJson<T>(config.baseUrl, config.secretKey, method, path, body);
}

/**
 * Resolve the local capability broker independently from the API target.
 * A remote --url is a signing target and must never receive the bearer
 * capability that is only valid at the session's local Autopilot instance.
 */
export function resolveCapabilityBrokerUrl(targetBaseUrl?: string): string {
  return resolveBaseUrl(Bun.env.WINGMAN_BROKER_URL ?? Bun.env.WINGMAN_URL ?? targetBaseUrl);
}

/**
 * Resolve the Wingman base URL from CLI flag or env.
 * Priority: urlInput arg → WINGMAN_URL → http://localhost:{PORT} → http://localhost:3000
 */
export function resolveBaseUrl(urlInput?: string): string {
  let url: string;
  if (urlInput) {
    url = urlInput.replace(/\/$/, "");
  } else if (Bun.env.WINGMAN_URL) {
    url = Bun.env.WINGMAN_URL.replace(/\/$/, "");
  } else {
    const port = Number.parseInt(Bun.env.PORT ?? "3000", 10);
    const effectivePort = Number.isFinite(port) && port > 0 ? port : 3000;
    url = `http://127.0.0.1:${effectivePort}`;
  }
  // Validate URL scheme to prevent SSRF via protocol smuggling
  const parsed = URL.parse(url);
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new Error("base_url must use http or https scheme");
  }
  return url;
}

/**
 * Parse common CLI flags (--url, --key, --json, --help) from argv.
 * Returns remaining positional args and parsed config.
 */
export function parseCommonFlags(argv: string[]): {
  args: string[];
  urlInput?: string;
  keyInput?: string;
  asJson: boolean;
  help: boolean;
  botCrypto: boolean;
} {
  const args: string[] = [];
  let urlInput: string | undefined;
  let keyInput: string | undefined;
  let asJson = false;
  let help = false;
  let botCrypto = false;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    switch (flag) {
      case "--url":
      case "--base-url": {
        const value = argv[i + 1];
        if (!value) throw new Error(`${flag} requires a value`);
        urlInput = value;
        i++;
        break;
      }
      case "--key": {
        const value = argv[i + 1];
        if (!value) throw new Error("--key requires a value");
        keyInput = value;
        i++;
        break;
      }
      case "--json":
        asJson = true;
        break;
      case "--bot-crypto":
        botCrypto = true;
        break;
      case "-h":
      case "--help":
        help = true;
        break;
      default:
        args.push(flag);
    }
  }

  // Agent sessions already receive a short-lived, session-bound capability.
  // Select the supported broker path automatically instead of requiring every
  // agent to discover and repeat --bot-crypto. An explicit operator key still
  // selects the operator signing path.
  if (!keyInput && Bun.env.SESSION_ID?.trim() && Bun.env.WINGMAN_CAPABILITY?.trim()) {
    botCrypto = true;
  }

  return { args, urlInput, keyInput, asJson, help, botCrypto };
}

/**
 * Build a CliConfig from parsed flags.
 */
export function buildConfig(urlInput?: string, keyInput?: string): CliConfig {
  return {
    baseUrl: resolveBaseUrl(urlInput),
    secretKey: resolveSecretKey(keyInput),
  };
}

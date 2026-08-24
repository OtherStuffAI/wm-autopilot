import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { bytesToHex } from "@noble/hashes/utils";

import { getBotDisplayName } from "./bot-identity-publisher";
import { sharedStateStore, type SharedStateStore } from "../storage/shared-state-store";

export interface WingmanInstanceIdentity {
  nsec: string;
  nsecHex: string;
  secretKey: Uint8Array;
  pubkeyHex: string;
  npub: string;
  displayName: string;
  source: "env" | "shared_state" | "generated";
}

export interface WingmanIdentityPublicDetails {
  botNpub: string;
  botPubkeyHex: string;
  displayName: string;
  keySource: WingmanInstanceIdentity["source"];
}

type ConfigEnvironment = Record<string, string | undefined>;

let cachedIdentity: WingmanInstanceIdentity | null | undefined;

const WINGMAN_PRIV_SHARED_STATE_KEY = "wingman_priv";

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.substring(index, index + 2), 16);
  }
  return bytes;
}

function decodeWingmanPriv(input: string): Uint8Array {
  const value = input.trim();
  if (!value) {
    throw new Error("WINGMAN_PRIV is empty");
  }

  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return hexToBytes(value);
  }

  let decoded: ReturnType<typeof nip19.decode>;
  try {
    decoded = nip19.decode(value);
  } catch (error) {
    throw new Error(`WINGMAN_PRIV must be an nsec1 private key: ${(error as Error).message}`);
  }
  if (decoded.type !== "nsec" || !(decoded.data instanceof Uint8Array)) {
    throw new Error("WINGMAN_PRIV must be an nsec1 private key");
  }
  if (decoded.data.length !== 32) {
    throw new Error("WINGMAN_PRIV nsec must decode to 32 bytes");
  }
  return new Uint8Array(decoded.data);
}

export function loadWingmanInstanceIdentity(
  env: ConfigEnvironment = Bun.env,
  store: SharedStateStore = sharedStateStore,
): WingmanInstanceIdentity | null {
  if (env === Bun.env && cachedIdentity !== undefined) {
    return cachedIdentity;
  }

  const raw = env.WINGMAN_PRIV?.trim();
  if (raw) {
    const identity = buildWingmanInstanceIdentity(decodeWingmanPriv(raw), "env");
    if (env === Bun.env) cachedIdentity = identity;
    return identity;
  }

  const stored = store.get(WINGMAN_PRIV_SHARED_STATE_KEY);
  if (stored) {
    const identity = buildWingmanInstanceIdentity(
      decodeWingmanPriv(stored),
      "shared_state",
    );
    if (env === Bun.env) cachedIdentity = identity;
    return identity;
  }

  const secretKey = generateSecretKey();
  const nsec = nip19.nsecEncode(secretKey);
  store.set(WINGMAN_PRIV_SHARED_STATE_KEY, nsec);
  const identity = buildWingmanInstanceIdentity(secretKey, "generated");
  if (env === Bun.env) cachedIdentity = identity;
  return identity;
}

function buildWingmanInstanceIdentity(
  secretKey: Uint8Array,
  source: WingmanInstanceIdentity["source"],
): WingmanInstanceIdentity {
  const pubkeyHex = getPublicKey(secretKey);
  const nsec = nip19.nsecEncode(secretKey);
  return {
    nsec,
    nsecHex: bytesToHex(secretKey),
    secretKey,
    pubkeyHex,
    npub: nip19.npubEncode(pubkeyHex),
    displayName: getBotDisplayName(pubkeyHex),
    source,
  };
}

export function getWingmanIdentityPublicDetails(
  identity: WingmanInstanceIdentity,
): WingmanIdentityPublicDetails {
  return {
    botNpub: identity.npub,
    botPubkeyHex: identity.pubkeyHex,
    displayName: identity.displayName,
    keySource: identity.source,
  };
}

export function buildWingmanIdentityEnv(
  identity: WingmanInstanceIdentity,
): Record<string, string> {
  return {
    WINGMAN_NPUB: identity.npub,
  };
}

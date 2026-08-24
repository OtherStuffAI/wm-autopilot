import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import type { WappAppKeyMode } from "./types";

export function decodeWappAppNsec(value: string): Uint8Array {
  const raw = value.trim();
  if (raw.startsWith("nsec1")) {
    const decoded = nip19.decode(raw);
    if (decoded.type !== "nsec" || !(decoded.data instanceof Uint8Array)) {
      throw new Error("WAPP_NSEC must be a valid nsec value");
    }
    return decoded.data;
  }
  if (/^[a-fA-F0-9]{64}$/.test(raw)) {
    return Uint8Array.from(Buffer.from(raw, "hex"));
  }
  throw new Error("WAPP_NSEC must be nsec1... or 64-char hex");
}

export function deriveWappAppNpubFromNsec(nsec: string): string {
  return nip19.npubEncode(getPublicKey(decodeWappAppNsec(nsec)));
}

export function createWappAppNsec(mode: WappAppKeyMode | undefined, importedNsec: string | null | undefined): string {
  if (mode === "import") {
    if (!importedNsec?.trim()) {
      throw new Error("WAPP_NSEC is required when importing a WApp app key");
    }
    decodeWappAppNsec(importedNsec);
    return importedNsec.trim();
  }
  if (importedNsec?.trim()) {
    decodeWappAppNsec(importedNsec);
    return importedNsec.trim();
  }
  return nip19.nsecEncode(generateSecretKey());
}

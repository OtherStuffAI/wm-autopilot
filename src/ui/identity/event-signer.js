import * as deviceKeystore from "./device-keystore.js";

async function signWithDeviceKey(eventTemplate) {
  const stored = await deviceKeystore.retrieveNsec();
  if (!stored?.nsec) {
    return null;
  }

  const { finalizeEvent } = await import("/vendor/nostr-tools/index.js");
  const secretKey = stored.nsec;
  try {
    const signed = finalizeEvent(eventTemplate, secretKey);
    return {
      id: signed.id,
      pubkey: signed.pubkey,
      created_at: signed.created_at,
      kind: signed.kind,
      tags: signed.tags,
      content: signed.content,
      sig: signed.sig,
    };
  } finally {
    secretKey.fill(0);
  }
}

export async function signIdentityEvent(eventTemplate) {
  if (window.nostr && typeof window.nostr.signEvent === "function") {
    return await window.nostr.signEvent(eventTemplate);
  }

  const bunkerSigner = globalThis.wingmanIdentity?.bunkerSigner;
  if (bunkerSigner && typeof bunkerSigner.signEvent === "function") {
    return await bunkerSigner.signEvent(eventTemplate);
  }

  const deviceSigned = await signWithDeviceKey(eventTemplate);
  if (deviceSigned) {
    return deviceSigned;
  }

  throw new Error("No signer available. Use NIP-07, a bunker signer, or local keys.");
}

/** Failure with a fixed code only; untrusted proxy text never reaches the message. */
export class TinfoilProxyError extends Error {
  constructor(readonly code: string) { super("tinfoil_verified_proxy_unavailable"); }
}

export interface TinfoilVerification {
  enclave: string; repo: string; project: string; releaseDigest: string; platform: "sev-snp" | "tdx";
  tlsKeyFingerprint: string; verifiedAt: string; expiresAt: string;
}
export interface TinfoilReady { listen: string; verification: TinfoilVerification; expiresAtMs: number }

const MAX_FIELD = 512;
const MAX_CLOCK_SKEW_MS = 60_000;
const RFC3339_UTC = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/;

function field(source: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = source[key];
  if (typeof value !== "string" || value.length > MAX_FIELD || (!allowEmpty && !value) || /[\u0000-\u001f\u007f]/.test(value)) throw new TinfoilProxyError("verification_invalid");
  return value;
}

function timestamp(value: string): number {
  const match = RFC3339_UTC.exec(value);
  const ms = match ? Date.parse(`${match[1]}.${(match[2] ?? "").padEnd(3, "0").slice(0, 3)}Z`) : NaN;
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== match?.[1]) throw new TinfoilProxyError("verification_invalid");
  return ms;
}

/**
 * Validate the current upstream `ready` message: `{event, listen, verification}` where `verification` is the
 * proxy's verificationSummary. The legacy `verification_document` form has no machine-checkable expiry and is refused.
 */
export function parseTinfoilReady(message: Record<string, unknown>, now: number): TinfoilReady {
  const listen = message.listen;
  const port = typeof listen === "string" ? /^127\.0\.0\.1:(\d{1,5})$/.exec(listen)?.[1] : undefined;
  if (!port || Number(port) < 1 || Number(port) > 65_535) throw new TinfoilProxyError("verification_invalid");
  const summary = message.verification;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) throw new TinfoilProxyError("verification_invalid");
  const source = summary as Record<string, unknown>;
  const platform = source.platform;
  if (platform !== "sev-snp" && platform !== "tdx") throw new TinfoilProxyError("verification_invalid");
  const verification: TinfoilVerification = {
    enclave: field(source, "enclave"), repo: field(source, "repo"), project: field(source, "project", true),
    releaseDigest: field(source, "release_digest"), platform, tlsKeyFingerprint: field(source, "tls_key_fingerprint"),
    verifiedAt: field(source, "verified_at"), expiresAt: field(source, "expires_at"),
  };
  const verifiedMs = timestamp(verification.verifiedAt);
  const expiresAtMs = timestamp(verification.expiresAt);
  if (verifiedMs > now + MAX_CLOCK_SKEW_MS || expiresAtMs <= verifiedMs) throw new TinfoilProxyError("verification_invalid");
  if (expiresAtMs <= now) throw new TinfoilProxyError("attestation_stale");
  return { listen: listen as string, verification, expiresAtMs };
}

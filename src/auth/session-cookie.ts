import { createHmac, randomBytes } from "node:crypto";

import { getSessionSecretBytes } from "./session-secret";

export interface SessionCookiePayload {
  npub: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

export const SECURE_SESSION_COOKIE_NAME = "__Host-wingman_identity_session";
export const INSECURE_SESSION_COOKIE_NAME = "wingman_identity_session";
export const SESSION_COOKIE_NAME = SECURE_SESSION_COOKIE_NAME;
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
export const SESSION_TTL_MS = SESSION_MAX_AGE_SECONDS * 1000;

const NPUB_REGEX = /^npub1[0-9ac-hj-np-z]{10,}$/;

const toBase64Url = (input: Uint8Array) =>
  Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const fromBase64Url = (value: string) => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, "base64");
};

export class SessionCookieError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionCookieError";
  }
}

export const validateNpub = (value: string): boolean => NPUB_REGEX.test(value);

export const parseCookies = (header: string | null | undefined): Record<string, string> => {
  if (!header) return {};
  return header
    .split(";")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .reduce<Record<string, string>>((acc, segment) => {
      const [rawName, ...rawValue] = segment.split("=");
      if (!rawName) return acc;
      const name = rawName.trim();
      const value = rawValue.join("=").trim();
      acc[name] = value;
      return acc;
    }, {});
};

const encodePayload = (payload: SessionCookiePayload): string => {
  const json = JSON.stringify(payload);
  const data = new TextEncoder().encode(json);
  return toBase64Url(data);
};

const decodePayload = (encoded: string): SessionCookiePayload => {
  let parsed: unknown;
  try {
    const bytes = fromBase64Url(encoded);
    const json = bytes.toString("utf8");
    parsed = JSON.parse(json);
  } catch {
    throw new SessionCookieError("Invalid session payload encoding");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new SessionCookieError("Invalid session payload structure");
  }

  const { npub, nonce, issuedAt, expiresAt } = parsed as Record<string, unknown>;
  if (typeof npub !== "string" || !validateNpub(npub)) {
    throw new SessionCookieError("Invalid session npub");
  }
  if (typeof nonce !== "string" || nonce.length === 0) {
    throw new SessionCookieError("Invalid session nonce");
  }
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
    throw new SessionCookieError("Invalid session timestamps");
  }

  return {
    npub,
    nonce,
    issuedAt: Number(issuedAt),
    expiresAt: Number(expiresAt),
  };
};

const signPayload = (encoded: string): string => {
  const secret = getSessionSecretBytes();
  const hmac = createHmac("sha256", secret);
  hmac.update(encoded);
  return toBase64Url(hmac.digest());
};

export interface MintSessionCookieOptions {
  secure?: boolean;
}

export const getSessionCookieName = (secure: boolean): string => {
  return secure ? SECURE_SESSION_COOKIE_NAME : INSECURE_SESSION_COOKIE_NAME;
};

export const mintSessionCookie = (
  npub: string,
  options: MintSessionCookieOptions = {},
): { cookie: string; expiresAt: number; payload: SessionCookiePayload } => {
  if (!validateNpub(npub)) {
    throw new SessionCookieError("Invalid npub");
  }

  const issuedAt = Date.now();
  const expiresAt = issuedAt + SESSION_TTL_MS;
  const payload: SessionCookiePayload = {
    npub,
    nonce: toBase64Url(randomBytes(18)),
    issuedAt,
    expiresAt,
  };

  const encodedPayload = encodePayload(payload);
  const signature = signPayload(encodedPayload);
  const value = `${encodedPayload}.${signature}`;
  const expiryDate = new Date(expiresAt).toUTCString();
  const secure = options.secure ?? true;
  const cookieName = getSessionCookieName(secure);
  const secureFlag = secure ? "; Secure" : "";
  const cookie = `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict${secureFlag}; Max-Age=${SESSION_MAX_AGE_SECONDS}; Expires=${expiryDate}`;

  return { cookie, expiresAt, payload };
};

export const readSessionCookie = (cookieHeader: string | null | undefined): SessionCookiePayload | null => {
  const cookies = parseCookies(cookieHeader);
  const value = cookies[SECURE_SESSION_COOKIE_NAME] ?? cookies[INSECURE_SESSION_COOKIE_NAME];
  if (!value) return null;
  const [encodedPayload, signature] = value.split(".");
  if (!encodedPayload || !signature) {
    throw new SessionCookieError("Malformed session cookie");
  }

  const expectedSignature = signPayload(encodedPayload);
  if (signature !== expectedSignature) {
    throw new SessionCookieError("Invalid session signature");
  }

  const payload = decodePayload(encodedPayload);
  if (payload.expiresAt <= Date.now()) {
    throw new SessionCookieError("Session expired");
  }

  return payload;
};


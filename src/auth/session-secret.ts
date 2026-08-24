import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { TextEncoder } from "node:util";

let cachedSecret: Uint8Array | null = null;
let secretHash: string | null = null;

const encoder = new TextEncoder();

const generateSecureSecret = (): string => {
  return randomBytes(64).toString("base64url");
};

const validateSecretStrength = (secret: string): boolean => {
  if (secret.length < 32) return false;
  const hasUpper = /[A-Z]/.test(secret);
  const hasLower = /[a-z]/.test(secret);
  const hasNumber = /[0-9]/.test(secret);
  const hasSpecial = /[^A-Za-z0-9]/.test(secret);
  return [hasUpper, hasLower, hasNumber, hasSpecial].filter(Boolean).length >= 3;
};

const secureClear = (arr: Uint8Array): void => {
  for (let i = 0; i < arr.length; i++) {
    arr[i] = 0;
  }
};

export const getSessionSecretBytes = (): Uint8Array => {
  if (cachedSecret && secretHash) {
    const currentSource = Bun.env.IDENTITY_SESSION_SECRET?.trim() || "";
    if (currentSource) {
      const currentHash = createHash('sha256').update(encoder.encode(currentSource)).digest('hex');
      if (currentHash === secretHash) {
        return cachedSecret;
      } else {
        secureClear(cachedSecret);
        cachedSecret = null;
        secretHash = null;
      }
    }
  }

  const source = Bun.env.IDENTITY_SESSION_SECRET?.trim();

  if (!source) {
    throw new Error(
      "[auth] IDENTITY_SESSION_SECRET environment variable is required. " +
      "Please set a secure secret (minimum 32 characters with mixed case, numbers, and symbols)."
    );
  }

  if (!validateSecretStrength(source)) {
    throw new Error(
      "[auth] IDENTITY_SESSION_SECRET does not meet security requirements. " +
      "Must be at least 32 characters with mixed case, numbers, and symbols."
    );
  }

  cachedSecret = encoder.encode(source);
  secretHash = createHash('sha256').update(cachedSecret).digest('hex');
  
  return cachedSecret;
};

export const rotateSecret = (newSecret: string): void => {
  if (!validateSecretStrength(newSecret)) {
    throw new Error("New secret does not meet security requirements");
  }
  
  if (cachedSecret) {
    secureClear(cachedSecret);
  }
  
  cachedSecret = encoder.encode(newSecret);
  secretHash = createHash('sha256').update(cachedSecret).digest('hex');
};

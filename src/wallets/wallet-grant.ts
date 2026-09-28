import { WalletInputError } from "./wallet-errors.ts";
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { WalletConstraint } from "../signing/wallet-types.ts";
import { WALLET_READ_METHODS, WALLET_SPEND_METHODS } from "../signing/wallet-capability.ts";
import { loadWalletConfig, readPrivate, walletPath, writePrivate } from "./wallet-storage.ts";

export function validateWalletGrant(value: unknown): WalletConstraint {
  const grant = value as WalletConstraint;
  if (!grant || !Array.isArray(grant.readMethods) || !Array.isArray(grant.spendMethods)
    || grant.readMethods.some(method => !WALLET_READ_METHODS.has(method))
    || grant.spendMethods.some(method => !WALLET_SPEND_METHODS.has(method))
    || !Number.isSafeInteger(grant.maxSpendMsats) || !Number.isSafeInteger(grant.maxTotalSpendMsats)
    || grant.maxSpendMsats < 0 || grant.maxTotalSpendMsats < grant.maxSpendMsats
    || (grant.spendMethods.length > 0 && grant.maxSpendMsats === 0)) throw new WalletInputError("Invalid explicit wallet grant");
  return grant;
}
export function readWalletGrant(root: string, botNpub: string): WalletConstraint | undefined {
  const path = join(walletPath(root, botNpub), "grant.json");
  if (!existsSync(path)) return undefined;
  loadWalletConfig(walletPath(root, botNpub), botNpub);
  return validateWalletGrant(JSON.parse(readPrivate(path).toString()));
}
export function saveWalletGrant(root: string, botNpub: string, value: unknown): WalletConstraint {
  const directory = walletPath(root, botNpub);
  loadWalletConfig(directory, botNpub);
  const grant = validateWalletGrant(value);
  const path = join(directory, "grant.json");
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  writePrivate(temporary, JSON.stringify(grant));
  renameSync(temporary, path);
  return grant;
}

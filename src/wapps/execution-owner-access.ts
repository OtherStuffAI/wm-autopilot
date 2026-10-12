import type { WappRecord } from "./types";
import { normaliseNpub } from "../identity/npub-utils";
import { resolveSessionOwnerNpub } from "../sessions/session-ownership";

/** The current installation registry is authority, never caller-supplied session metadata. */
export function installedAppExecutionOwner(appNpub: string | null, installations: WappRecord[]): string | null {
  const normalized = normaliseNpub(appNpub);
  if (!normalized) return null;
  const owners = [...new Set(installations.filter(record =>
    normaliseNpub(record.appNpub) === normalized && record.recordState === "active" && record.status === "active",
  ).map(record => normaliseNpub(record.ownerNpub)).filter(Boolean))];
  return owners.length === 1 ? owners[0]! : null;
}

/** Installation ownership grants control of its app execution, never another owner. */
export function installedAppExecutionNpubs(owner: string | null, installations: WappRecord[]): string[] {
  const normalized = normaliseNpub(owner);
  if (!normalized) return [];
  return [...new Set(installations.map(record => normaliseNpub(record.appNpub)).filter((npub): npub is string =>
    !!npub && npub !== normalized && installedAppExecutionOwner(npub, installations) === normalized))];
}

export function installedAppSessionMatches(sessionNpub: string | null | undefined,
  metadata: {ownerNpub?: string} | null | undefined, viewer: string | null, installations: WappRecord[]): boolean {
  return !!viewer && installedAppExecutionOwner(resolveSessionOwnerNpub(sessionNpub,metadata), installations) === normaliseNpub(viewer);
}

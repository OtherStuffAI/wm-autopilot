import { nip19 } from "nostr-tools";

import type { SignedEvent } from "../ngit/relay-publisher";
import { validateSignedEventFields } from "../identity/nostr-event-utils";
import { normaliseNpub } from "../identity/npub-utils";

export const WORKSPACE_DELEGATION_KIND = "wingman-delegation-v1";
export const WORKSPACE_DELEGATION_EVENT_KIND = 30079;

export type DelegationBillingMode = "delegate" | "owner" | "shared";

export interface DelegationResourceFilters {
  projectRoots?: string[];
  pathPrefixes?: string[];
  appIds?: string[];
  appRoots?: string[];
  triggerIds?: string[];
  wappIds?: string[];
  workspaceIds?: string[];
  scopeIds?: string[];
}

export interface WorkspaceDelegationPayload {
  kind: typeof WORKSPACE_DELEGATION_KIND;
  ownerNpub: string;
  delegateNpub: string;
  scopes: string[];
  resourceFilters?: DelegationResourceFilters;
  billingMode: DelegationBillingMode;
  spendLimitSats: number | null;
  createdAt: number;
  expiresAt: number | null;
}

export interface ValidatedDelegationEvent {
  payload: WorkspaceDelegationPayload;
  signedEvent: SignedEvent;
}

function decodeNpubToPubkeyHex(npub: string): string {
  const decoded = nip19.decode(npub);
  if (decoded.type !== "npub") {
    throw new Error("Delegation owner must be an npub");
  }
  if (typeof decoded.data !== "string" || !/^[0-9a-fA-F]{64}$/.test(decoded.data)) {
    throw new Error("Invalid npub payload for delegation owner");
  }
  return decoded.data;
}

function normaliseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(
      value
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0),
    ),
  );
}

function normaliseNumericTimestamp(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value.trim(), 10)
        : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error("Delegation timestamps must be positive integers");
  }
  return Math.trunc(numeric);
}

function normaliseBillingMode(value: unknown): DelegationBillingMode {
  const billingMode = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (billingMode === "owner" || billingMode === "shared") {
    return billingMode;
  }
  return "delegate";
}

function normaliseSpendLimit(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value.trim(), 10)
        : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new Error("spendLimitSats must be a non-negative integer");
  }
  return Math.trunc(numeric);
}

function validateResourceFilters(input: unknown): DelegationResourceFilters | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const filters: DelegationResourceFilters = {};
  const projectRoots = normaliseStringArray(record.projectRoots);
  const pathPrefixes = normaliseStringArray(record.pathPrefixes);
  const appIds = normaliseStringArray(record.appIds);
  const appRoots = normaliseStringArray(record.appRoots);
  const triggerIds = normaliseStringArray(record.triggerIds);
  const wappIds = normaliseStringArray(record.wappIds);
  const workspaceIds = normaliseStringArray(record.workspaceIds);
  const scopeIds = normaliseStringArray(record.scopeIds);
  if (projectRoots.length > 0) {
    filters.projectRoots = projectRoots;
  }
  if (pathPrefixes.length > 0) {
    filters.pathPrefixes = pathPrefixes;
  }
  if (appIds.length > 0) {
    filters.appIds = appIds;
  }
  if (appRoots.length > 0) {
    filters.appRoots = appRoots;
  }
  if (triggerIds.length > 0) {
    filters.triggerIds = triggerIds;
  }
  if (wappIds.length > 0) filters.wappIds = wappIds;
  if (workspaceIds.length > 0) filters.workspaceIds = workspaceIds;
  if (scopeIds.length > 0) filters.scopeIds = scopeIds;
  return Object.keys(filters).length > 0 ? filters : undefined;
}

export function validateWorkspaceDelegationPayload(input: unknown): WorkspaceDelegationPayload {
  if (!input || typeof input !== "object") {
    throw new Error("Delegation payload must be an object");
  }

  const record = input as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind.trim() : "";
  if (kind !== WORKSPACE_DELEGATION_KIND) {
    throw new Error(`Delegation kind must be ${WORKSPACE_DELEGATION_KIND}`);
  }

  const ownerNpub = typeof record.ownerNpub === "string" ? normaliseNpub(record.ownerNpub) : null;
  if (!ownerNpub) {
    throw new Error("ownerNpub is required");
  }

  const delegateNpub = typeof record.delegateNpub === "string" ? normaliseNpub(record.delegateNpub) : null;
  if (!delegateNpub) {
    throw new Error("delegateNpub is required");
  }

  const scopes = normaliseStringArray(record.scopes);
  if (scopes.length === 0) {
    throw new Error("At least one delegation scope is required");
  }

  const createdAt = normaliseNumericTimestamp(record.createdAt);
  if (!createdAt) {
    throw new Error("createdAt is required");
  }

  const expiresAt = normaliseNumericTimestamp(record.expiresAt);
  if (expiresAt !== null && expiresAt <= createdAt) {
    throw new Error("expiresAt must be later than createdAt");
  }

  return {
    kind: WORKSPACE_DELEGATION_KIND,
    ownerNpub,
    delegateNpub,
    scopes,
    resourceFilters: validateResourceFilters(record.resourceFilters),
    billingMode: normaliseBillingMode(record.billingMode),
    spendLimitSats: normaliseSpendLimit(record.spendLimitSats),
    createdAt,
    expiresAt,
  };
}

export function validateSignedWorkspaceDelegationEvent(input: unknown): ValidatedDelegationEvent {
  if (!input || typeof input !== "object") {
    throw new Error("signedEvent must be an object");
  }

  const candidate = input as Partial<SignedEvent>;
  if (!Number.isInteger(candidate.kind) || Number(candidate.kind) <= 0) {
    throw new Error("signedEvent.kind must be a positive integer");
  }

  let payload: WorkspaceDelegationPayload;
  try {
    payload = validateWorkspaceDelegationPayload(
      typeof candidate.content === "string" ? JSON.parse(candidate.content) : null,
    );
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Invalid delegation payload: ${error.message}`);
    }
    throw error;
  }

  const ownerPubkeyHex = decodeNpubToPubkeyHex(payload.ownerNpub);
  const signedEvent = validateSignedEventFields(input, ownerPubkeyHex, "delegation owner");
  if (signedEvent.kind !== WORKSPACE_DELEGATION_EVENT_KIND) {
    throw new Error(`signedEvent.kind must be ${WORKSPACE_DELEGATION_EVENT_KIND}`);
  }

  return { payload, signedEvent };
}

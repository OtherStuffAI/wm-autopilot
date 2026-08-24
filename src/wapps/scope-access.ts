import { normaliseNpub } from "../identity/npub-utils";
import type { WappScopeLineage } from "./types";

export interface ScopeAccessInput {
  scopeId: string;
  ownerNpub: string;
  scopeLineage?: Partial<WappScopeLineage> | null;
}

export interface ScopeAccessResolution {
  scopeId: string;
  allowedNpubs: string[];
  scopeLineage: WappScopeLineage;
}

export interface ResolveWappScopeAccessInput {
  workspaceOwnerNpub: string;
  scopeId: string;
  ownerNpub: string;
  appRoot?: string | null;
  scopeLineage?: Partial<WappScopeLineage> | null;
}

export interface WappScopeAccessResolver {
  resolveWappScopeAccess(input: ResolveWappScopeAccessInput): Promise<ScopeAccessResolution>;
}

export interface WappScopeAccessGroup {
  group_id?: unknown;
  groupId?: unknown;
  id?: unknown;
  current_group_npub?: unknown;
  currentGroupNpub?: unknown;
  group_npub?: unknown;
  groupNpub?: unknown;
  member_npubs?: unknown;
  memberNpubs?: unknown;
  member_npubs_json?: unknown;
  memberNpubsJson?: unknown;
}

export class WappScopeAccessError extends Error {
  constructor(
    public readonly code: "scope-access-unavailable" | "invalid-scope" | "unresolvable-scope",
    message: string,
  ) {
    super(message);
    this.name = "WappScopeAccessError";
  }
}

export function normalizeWappScopeLineage(
  scopeId: string,
  input?: Partial<WappScopeLineage> | null,
): WappScopeLineage {
  return {
    scopeId,
    l1Id: input?.l1Id ?? null,
    l2Id: input?.l2Id ?? null,
    l3Id: input?.l3Id ?? null,
    l4Id: input?.l4Id ?? null,
    l5Id: input?.l5Id ?? null,
  };
}

export function normalizeNpubList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const unique = new Map<string, string>();
  for (const value of values) {
    const normalized = normaliseNpub(typeof value === "string" ? value : null);
    if (normalized) {
      unique.set(normalized, normalized);
    }
  }
  return Array.from(unique.values()).sort();
}

export function resolveWappAllowedNpubs(input: ScopeAccessInput & { memberNpubs?: unknown }): string[] {
  const owner = normaliseNpub(input.ownerNpub);
  if (!owner) {
    throw new Error("WApp owner npub is required");
  }
  const unique = new Map<string, string>();
  unique.set(owner, owner);
  for (const npub of normalizeNpubList(input.memberNpubs)) {
    unique.set(npub, npub);
  }
  return Array.from(unique.values()).sort();
}

export function buildWappScopeAccessResolution(
  input: ResolveWappScopeAccessInput & { memberNpubs?: unknown },
): ScopeAccessResolution {
  const scopeId = input.scopeId.trim();
  if (!scopeId) {
    throw new WappScopeAccessError("invalid-scope", "scopeId is required");
  }
  return {
    scopeId,
    scopeLineage: normalizeWappScopeLineage(scopeId, input.scopeLineage),
    allowedNpubs: resolveWappAllowedNpubs({
      scopeId,
      ownerNpub: input.ownerNpub,
      memberNpubs: input.memberNpubs,
    }),
  };
}

function pickString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function compactString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseJsonArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  const text = compactString(value);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function collectNpubs(value: unknown, target: Set<string>): void {
  if (!value) return;
  if (typeof value === "string") {
    const normalized = normaliseNpub(value);
    if (normalized) target.add(normalized);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectNpubs(entry, target);
    return;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of [
      "npub",
      "owner_npub",
      "ownerNpub",
      "member_npub",
      "memberNpub",
      "user_npub",
      "userNpub",
      "person_npub",
      "personNpub",
      "delegate_npub",
      "delegateNpub",
      "assigned_to_npub",
      "assignedTo",
    ]) {
      collectNpubs(record[key], target);
    }
  }
}

function collectScopeMemberNpubs(scope: Record<string, unknown>): string[] {
  const members = new Set<string>();
  for (const key of [
    "member_npubs",
    "memberNpubs",
    "members",
    "user_npubs",
    "userNpubs",
    "allowed_npubs",
    "allowedNpubs",
    "delegates",
    "shares",
  ]) {
    collectNpubs(scope[key], members);
  }
  return Array.from(members.values());
}

function collectGroupRefs(value: unknown, target: Set<string>): void {
  if (!value) return;
  if (typeof value === "string" && value.trim().length > 0) {
    target.add(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectGroupRefs(entry, target);
    return;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const shareType = compactString(record.type);
    if (!shareType || shareType === "group") {
      for (const key of ["group_id", "groupId", "group_npub", "groupNpub", "key"]) {
        collectGroupRefs(record[key], target);
      }
    }
  }
}

export function collectWappScopeGroupRefs(scope: Record<string, unknown>): string[] {
  const refs = new Set<string>();
  for (const key of [
    "group_ids",
    "groupIds",
    "access_group_ids",
    "accessGroupIds",
    "readable_group_ids",
    "readableGroupIds",
  ]) {
    collectGroupRefs(scope[key], refs);
  }
  collectGroupRefs(scope.shares, refs);
  return Array.from(refs.values()).sort();
}

function groupRefsFor(record: Record<string, unknown>): string[] {
  const refs = new Set<string>();
  for (const key of [
    "group_id",
    "groupId",
    "id",
    "current_group_npub",
    "currentGroupNpub",
    "group_npub",
    "groupNpub",
  ]) {
    const value = compactString(record[key]);
    if (value) refs.add(value);
  }
  return Array.from(refs.values());
}

function collectResolvedGroupMemberNpubs(scope: Record<string, unknown>, groupRefs: string[]): string[] {
  if (groupRefs.length === 0) return [];
  const rawGroups = scope.accessGroups ?? scope.access_groups ?? scope.scopeAccessGroups;
  if (!Array.isArray(rawGroups)) {
    throw new WappScopeAccessError(
      "unresolvable-scope",
      `Scope ${compactString(scope.record_id) ?? "access"} references groups but group membership data is unavailable`,
    );
  }

  const groupsByRef = new Map<string, Record<string, unknown>>();
  for (const group of rawGroups) {
    if (!group || typeof group !== "object") continue;
    const record = group as Record<string, unknown>;
    for (const ref of groupRefsFor(record)) {
      groupsByRef.set(ref, record);
    }
  }

  const members = new Set<string>();
  for (const groupRef of groupRefs) {
    const group = groupsByRef.get(groupRef);
    if (!group) {
      throw new WappScopeAccessError("unresolvable-scope", `Scope group ${groupRef} could not be resolved`);
    }
    const rawMembers = group.member_npubs ?? group.memberNpubs
      ?? parseJsonArray(group.member_npubs_json ?? group.memberNpubsJson);
    if (!Array.isArray(rawMembers)) {
      throw new WappScopeAccessError("unresolvable-scope", `Scope group ${groupRef} membership is unavailable`);
    }
    for (const npub of normalizeNpubList(rawMembers)) {
      members.add(npub);
    }
  }
  return Array.from(members.values());
}

function lineageFromScope(scopeId: string, scope: Record<string, unknown>): WappScopeLineage {
  return normalizeWappScopeLineage(scopeId, {
    l1Id: pickString(scope, ["scope_l1_id", "l1Id", "l1_id"]) ?? null,
    l2Id: pickString(scope, ["scope_l2_id", "l2Id", "l2_id"]) ?? null,
    l3Id: pickString(scope, ["scope_l3_id", "l3Id", "l3_id"]) ?? null,
    l4Id: pickString(scope, ["scope_l4_id", "l4Id", "l4_id"]) ?? null,
    l5Id: pickString(scope, ["scope_l5_id", "l5Id", "l5_id"]) ?? null,
  });
}

export class FlightDeckScopeAccessResolver implements WappScopeAccessResolver {
  constructor(
    private readonly loadScope: (input: ResolveWappScopeAccessInput) => Promise<Record<string, unknown> | null>,
  ) {}

  async resolveWappScopeAccess(input: ResolveWappScopeAccessInput): Promise<ScopeAccessResolution> {
    const scopeId = input.scopeId.trim();
    if (!scopeId) {
      throw new WappScopeAccessError("invalid-scope", "scopeId is required");
    }
    let scope: Record<string, unknown> | null;
    try {
      scope = await this.loadScope({ ...input, scopeId });
    } catch (error) {
      throw new WappScopeAccessError(
        "scope-access-unavailable",
        `Unable to load scope access: ${(error as Error).message}`,
      );
    }
    if (!scope) {
      throw new WappScopeAccessError("invalid-scope", `Scope ${scopeId} was not found`);
    }
    const scopeWorkspaceOwner = normaliseNpub(pickString(scope, [
      "workspace_owner_npub",
      "workspaceOwnerNpub",
      "owner_npub",
      "ownerNpub",
    ]));
    const requestedWorkspaceOwner = normaliseNpub(input.workspaceOwnerNpub);
    if (scopeWorkspaceOwner && requestedWorkspaceOwner && scopeWorkspaceOwner !== requestedWorkspaceOwner) {
      throw new WappScopeAccessError("invalid-scope", "Scope does not belong to the selected workspace");
    }
    const groupRefs = collectWappScopeGroupRefs(scope);
    return buildWappScopeAccessResolution({
      ...input,
      scopeId,
      scopeLineage: lineageFromScope(scopeId, scope),
      memberNpubs: [
        ...collectScopeMemberNpubs(scope),
        ...collectResolvedGroupMemberNpubs(scope, groupRefs),
      ],
    });
  }
}

export class UnavailableWappScopeAccessResolver implements WappScopeAccessResolver {
  async resolveWappScopeAccess(): Promise<ScopeAccessResolution> {
    throw new WappScopeAccessError(
      "scope-access-unavailable",
      "WApp scope access resolution is not configured",
    );
  }
}

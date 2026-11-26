import { nip19 } from "nostr-tools";

import type { BackendConnectionRecord, RuntimeBotIdentity } from "../agent-chat/types";
import { FlightDeckPgResponseError } from "../flightdeck-pg/response-error";
import { FlightDeckPgClient } from "../flightdeck-pg/client";
import { normaliseBackendBaseUrl } from "../agent-chat/tower-client";
import { normaliseNpub } from "../identity/npub-utils";
import { buildWappScopeAccessResolution, WappScopeAccessError, type ResolveWappScopeAccessInput, type WappScopeAccessResolver } from "./scope-access";

interface ScopeClient {
  listWorkspaces(): Promise<unknown>;
  showWorkspace(workspaceId: string): Promise<unknown>;
  listScopes(workspaceId: string): Promise<unknown>;
  scopeGrants(workspaceId: string, scopeId: string): Promise<unknown>;
  listGroups(workspaceId: string): Promise<unknown>;
}

export interface PgScopeAccessDependencies {
  connections: { listAvailableForManagerNpub(npub: string): BackendConnectionRecord[] };
  withIdentity: <T>(actorNpub: string, managerNpub: string, operation: (identity: RuntimeBotIdentity) => Promise<T>) => Promise<T>;
  createClient?: (connection: BackendConnectionRecord, identity: RuntimeBotIdentity) => ScopeClient;
}

function unavailable(message: string): never {
  throw new WappScopeAccessError("unresolvable-scope", message);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return unavailable("Invalid PG scope access response");
  return value as Record<string, unknown>;
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return unavailable("Missing PG scope access records");
  return value.map(record);
}

function required(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return unavailable("Missing PG scope access identity");
  return value.trim();
}

function npub(value: unknown): string {
  const normalized = normaliseNpub(required(value));
  if (!normalized) return unavailable("Invalid PG member identity");
  try {
    if (nip19.decode(normalized).type !== "npub") return unavailable("Invalid PG member identity");
  } catch { return unavailable("Invalid PG member identity"); }
  return normalized;
}

function verifyIdentity(payload: Record<string, unknown>, connection: BackendConnectionRecord, workspaceId: string, owner: string, workspaceServiceNpub?: unknown) {
  const identity = record(payload.identity);
  if (identity.workspace_id !== workspaceId || identity.workspace_owner_npub !== owner
    || identity.app_npub !== connection.setupSourceAppNpub
    || !identity.workspace_service_npub || !identity.tower_service_npub
    || (workspaceServiceNpub !== undefined && identity.workspace_service_npub !== workspaceServiceNpub)
    || (connection.serviceNpub && identity.tower_service_npub !== connection.serviceNpub)) {
    unavailable("PG scope access workspace, owner, service or source app identity mismatch");
  }
}

/** Uses canonical exact-scope grants and server-expanded nested group membership.
 * Scope visibility alone, parent scopes and caller-supplied allowlists confer no access. */
export class PgWappScopeAccessResolver implements WappScopeAccessResolver {
  constructor(private readonly deps: PgScopeAccessDependencies) {}

  async resolveWappScopeAccess(input: ResolveWappScopeAccessInput) {
    try {
      const owner = npub(input.workspaceOwnerNpub);
      const manager = npub(input.managerNpub);
      const actor = npub(input.actorNpub);
      const scopeId = required(input.scopeId);
      const binding = input.towerBinding;
      if (binding && binding.workspaceOwnerNpub !== owner) unavailable("Tower binding belongs to another workspace owner");
      const connections = this.deps.connections.listAvailableForManagerNpub(manager).filter(connection => (
        connection.setupWorkspaceOwnerNpub === owner && connection.setupSourceAppNpub
        && (!binding || normaliseBackendBaseUrl(connection.backendBaseUrl) === normaliseBackendBaseUrl(binding.towerUrl))
      ));
      if (connections.length !== 1) unavailable("Exactly one authorized backend connection is required for WApp scope access");
      const connection = connections[0]!;
      return await this.deps.withIdentity(actor, manager, async identity => {
        if (identity.botNpub !== actor) unavailable("Scope access signer must retain the requesting identity");
        const client = this.deps.createClient?.(connection, identity) ?? new FlightDeckPgClient({
          backendConnectionId: connection.backendConnectionId,
          towerUrl: connection.backendBaseUrl,
          wingmanUrl: "",
          appNpub: connection.setupSourceAppNpub!,
          botIdentity: identity,
        });
        let workspaceId = binding?.workspaceId;
        if (!workspaceId) {
          const workspaces = record(await client.listWorkspaces());
          if (workspaces.next_cursor) unavailable("Incomplete PG workspace discovery");
          const matches = rows(workspaces.workspaces).filter(workspace => record(workspace.identity).workspace_owner_npub === owner);
          if (matches.length !== 1) unavailable("Selected PG workspace is missing or ambiguous");
          workspaceId = required(record(matches[0]!.identity).workspace_id);
          verifyIdentity(matches[0]!, connection, workspaceId, owner);
        }
        const descriptor = record(await client.showWorkspace(workspaceId));
        verifyIdentity(descriptor, connection, workspaceId, owner);
        const workspaceServiceNpub = record(descriptor.identity).workspace_service_npub;
        const payload = record(await client.listScopes(workspaceId));
        verifyIdentity(payload, connection, workspaceId, owner, workspaceServiceNpub);
        if (payload.next_cursor) unavailable("Incomplete PG scope discovery");
        const scopes = rows(payload.scopes).filter(scope => scope.id === scopeId);
        if (scopes.length !== 1 || scopes[0]!.workspace_id !== workspaceId) unavailable("Scope does not belong to the selected workspace");
        const scope = scopes[0]!;
        const access = record(await client.scopeGrants(workspaceId, scopeId));
        verifyIdentity(access, connection, workspaceId, owner, workspaceServiceNpub);
        if (access.scope_id !== scopeId || access.can_manage !== true) unavailable("Complete exact-scope permission inspection requires scope.manage");
        const grants = rows(access.grants);
        const principals = record(access.principals);
        const actors = new Map(rows(principals.actors).map(actor => [required(actor.id), npub(actor.npub)]));
        const groupChoices = new Set(rows(principals.groups).map(group => required(group.id)));
        const members = new Set<string>();
        const groupIds = new Set<string>();
        for (const grant of grants) {
          if (!Array.isArray(grant.permissions) || grant.permissions.some(permission => typeof permission !== "string")) unavailable("Invalid PG permission data");
          if (!grant.permissions.includes("scope.read")) continue;
          const id = required(grant.principal_id);
          if (grant.principal_type === "actor") {
            const member = actors.get(id);
            if (!member || member !== npub(grant.npub)) unavailable("Scope actor is not a matching workspace member");
            members.add(member);
          } else if (grant.principal_type === "group" && groupChoices.has(id)) groupIds.add(id);
          else unavailable("Scope permission principal is unavailable");
        }
        if (groupIds.size) {
          const groupsPayload = record(await client.listGroups(workspaceId));
          verifyIdentity(groupsPayload, connection, workspaceId, owner, workspaceServiceNpub);
          if (groupsPayload.next_cursor) unavailable("Incomplete PG group resolution");
          const groups = rows(groupsPayload.groups);
          for (const id of groupIds) {
            const matches = groups.filter(group => group.id === id && group.workspace_id === workspaceId);
            if (matches.length !== 1) unavailable("Scope group could not be resolved in the selected workspace");
            const group = matches[0]!;
            if (!Array.isArray(group.effective_member_npubs)) unavailable("Effective scope group membership is unavailable");
            const effective = rows(group.effective_members);
            const resolved = effective.map(member => {
              const value = npub(member.npub);
              if (actors.get(required(member.id)) !== value) unavailable("Scope group member is not a matching workspace actor");
              return value;
            });
            const advertised = group.effective_member_npubs.map(npub).sort();
            if (JSON.stringify([...resolved].sort()) !== JSON.stringify(advertised)) unavailable("Effective group membership identities do not match");
            for (const value of resolved) members.add(value);
          }
        }
        return buildWappScopeAccessResolution({ ...input, memberNpubs: [...members], scopeLineage: {
          // The current typed PG scope contract is flat. Only authoritative fields
          // from the server may extend it; never reuse caller-supplied lineage.
          l1Id: scope.scope_l1_id == null ? null : required(scope.scope_l1_id),
          l2Id: scope.scope_l2_id == null ? null : required(scope.scope_l2_id),
          l3Id: scope.scope_l3_id == null ? null : required(scope.scope_l3_id),
          l4Id: scope.scope_l4_id == null ? null : required(scope.scope_l4_id),
          l5Id: scope.scope_l5_id == null ? null : required(scope.scope_l5_id),
        } });
      });
    } catch (error) {
      if (error instanceof WappScopeAccessError) throw error;
      if (error instanceof FlightDeckPgResponseError && error.status === 404) {
        throw new WappScopeAccessError("invalid-scope", "Selected PG workspace or scope access resource is unavailable");
      }
      throw new WappScopeAccessError("scope-access-unavailable", `Unable to resolve typed PG scope access: ${(error as Error).message}`);
    }
  }
}

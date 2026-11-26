import { expect } from "bun:test";
import { finalizeEvent, getPublicKey, nip19, verifyEvent } from "nostr-tools";
import type { BackendConnectionRecord } from "../../agent-chat/types";
import { FlightDeckPgClient } from "../../flightdeck-pg/client";
import { PgWappScopeAccessResolver } from "../pg-scope-access";
import type { ResolveWappScopeAccessInput } from "../scope-access";

export const secret = new Uint8Array(32).fill(7);
export const actor = nip19.npubEncode(getPublicKey(secret));
export const owner = nip19.npubEncode("11".repeat(32));
export const member = nip19.npubEncode("22".repeat(32));
export const outsider = nip19.npubEncode("33".repeat(32));

export function pgScopeFixture() {
  const connection = { backendConnectionId: "connection-1", backendBaseUrl: "https://pg.example", serviceNpub: "service-1",
    setupWorkspaceOwnerNpub: owner, setupSourceAppNpub: "app-1" } as BackendConnectionRecord;
  const identity = { workspace_id: "workspace-1", workspace_owner_npub: owner, workspace_service_npub: "workspace-service-1",
    tower_service_npub: "service-1", app_npub: "app-1" };
  const scope = { id: "scope-1", workspace_id: "workspace-1", kind: "project" };
  const responses: Record<string, any> = {
    "/api/v4/flightdeck-pg/workspaces": { workspaces: [{ identity }], next_cursor: null },
    "/api/v4/flightdeck-pg/workspaces/workspace-1/descriptor": { identity },
    "/api/v4/flightdeck-pg/workspaces/workspace-1/scopes": { identity, scopes: [scope], next_cursor: null },
    "/api/v4/flightdeck-pg/workspaces/workspace-1/scopes/scope-1/grants": {
      identity, scope_id: "scope-1", can_manage: true,
      principals: { actors: [{ id: "actor-1", npub: member }, { id: "actor-2", npub: outsider }], groups: [{ id: "group-1" }] },
      grants: [{ principal_type: "group", principal_id: "group-1", permissions: ["scope.read"] },
        { principal_type: "actor", principal_id: "actor-2", npub: outsider, permissions: ["scope.manage"] }],
    },
    "/api/v4/flightdeck-pg/workspaces/workspace-1/groups": { identity, next_cursor: null, groups: [{
      id: "group-1", workspace_id: "workspace-1", member_npubs: [], child_group_ids: ["nested-group"],
      effective_member_npubs: [member], effective_members: [{ id: "actor-1", npub: member }],
    }] },
  };
  const requests: string[] = [];
  const signed: string[] = [];
  const resolver = new PgWappScopeAccessResolver({
    connections: { listAvailableForManagerNpub: manager => manager === owner ? [connection] : [] },
    withIdentity: async (requestedActor, manager, operation) => {
      expect(requestedActor).toBe(actor);
      expect(manager).toBe(owner);
      return operation({ botNpub: actor, botPubkeyHex: getPublicKey(secret), signNip98: async ({ url, method }) => {
        signed.push(url);
        const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: "", tags: [["u", url], ["method", method]] }, secret);
        return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
      } });
    },
    createClient: (selected, signer) => {
      expect(selected.backendConnectionId).toBe(connection.backendConnectionId);
      return new FlightDeckPgClient({ backendConnectionId: selected.backendConnectionId, towerUrl: selected.backendBaseUrl,
        wingmanUrl: "", appNpub: selected.setupSourceAppNpub!, botIdentity: { ...signer,
          towerTransport: { prepare: async url => url, fetch: async (url, init) => serve(url, init) } },
      });
    },
  });
  async function serve(url: string | URL, init?: RequestInit) {
    const headers = new Headers(init?.headers);
    const event = JSON.parse(Buffer.from(headers.get("Authorization")!.slice(6), "base64").toString());
    expect(verifyEvent(event)).toBe(true);
    expect(event.pubkey).toBe(getPublicKey(secret));
    expect(event.tags).toContainEqual(["u", String(url)]);
    expect(event.tags).toContainEqual(["method", "GET"]);
    expect(headers.get("x-flightdeck-pg-app-npub")).toBe("app-1");
    const path = new URL(url).pathname;
    requests.push(path);
    const response = responses[path];
    return response === undefined ? Response.json({ error: "not_found" }, { status: 404 }) : response instanceof Response ? response : Response.json(response);
  }
  const input: ResolveWappScopeAccessInput = { actorNpub: actor, managerNpub: owner, ownerNpub: owner,
    workspaceOwnerNpub: owner, scopeId: "scope-1", appRoot: "/no-board-config", scopeLineage: { l1Id: "injected" },
    towerBinding: { id: "binding-1", label: "Test", towerUrl: connection.backendBaseUrl, workspaceId: "workspace-1",
      workspaceOwnerNpub: owner, userAlias: null, isDefault: true, createdAt: "", updatedAt: "" },
  };
  return { resolver, input, responses, requests, signed, connection, identity, scope, owner, actor, member };
}

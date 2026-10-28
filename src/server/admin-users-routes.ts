import { buildAdminUserList, isConfiguredAdminNpub, isBootstrapAdminNpub } from "./admin-user-list";
/**
 * API route handlers for admin user management endpoints.
 * Extracted from server.ts to reduce file size.
 */

import {
  ADMIN_ROLE,
  wouldLeaveNoEffectiveAdmins,
} from "../auth/admin-npubs";
import { normaliseNpub } from "../identity/npub-utils";
import type { RequestAuthContext } from "../auth/request-context";
import type { AccessAction } from "../auth/access-control";
import type { SessionSnapshot } from "../agents/process-manager";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

// ---------- Types ----------

export type AdminUserRecord = {
  bot?: boolean;
  displayName?: string | null;
  active?: boolean;
  npub: string;
  normalizedNpub: string;
  alias: string;
  nickname: string | null;
  pictureUrl: string | null;
  approved: boolean;
  onboarded: boolean;
  onboardedAt: string | null;
  roles: string[];
  lastSeenAt: string | null;
  sessionCount: number;
  activeSessionCount: number;
  ports: number[];
  admin: boolean;
  assignedAdmin?: boolean;
  bootstrapAdmin: boolean;
  canDemoteAdmin: boolean;
};

// ---------- Context supplied by server.ts ----------

export interface AdminUsersApiContext {
  listBotIdentities?: () => Array<{ botNpub: string; displayName: string; active: boolean }>;
  adminNpub: string | null;
  bootstrapAdminNpubs?: string[];
  isAdminNpub?: (npub: string | null | undefined) => boolean;
  config: { connectRelays: string[] };

  identityUserStore: {
    listUsers: () => Array<{
      npub: string;
      normalizedNpub: string;
      alias: string;
      nickname: string | null;
      pictureUrl: string | null;
      roles: string[];
      onboardedAt: string | null;
      lastSeenAt: string | null;
      updatedAt: string | null;
      ports: number[];
    }>;
    setRole: (npub: string, role: string, value: boolean) => unknown;
    deleteUser: (npub: string) => boolean;
    setNickname: (npub: string, nickname: string | null) => { normalizedNpub: string };
    addPortsToUser: (npub: string, count: number) => { normalizedNpub: string; ports: number[] };
    touchExisting: (npub: string, opts: { lastSeenAt: string | null }) => void;
  };

  manager: { listSessions: () => SessionSnapshot[] };
  ensureApiAccess: (action: AccessAction, request: Request, url: URL, authContext: RequestAuthContext) => Promise<Response | null>;
  AccessActions: { AdminUsers: AccessAction };
  normaliseOptionalString: (value: unknown) => string | null;
  stopSessionsForUser: (npub: string | null | undefined) => Promise<void>;
  resolveAndCacheNostrProfile: (npub: string, opts: { force: boolean; relays: string[] }) => Promise<unknown>;
  buildIdentitySummaries: (sessions: SessionSnapshot[], viewerNpub: string | null, options?: { includeAll?: boolean }) => Array<{
    npub: string | null;
    normalizedNpub: string | null;
    sessionIds: string[];
    activeSessionIds: string[];
    lastSeenAt: string | null;
  }>;
}

// ---------- Helpers ----------

function adminMutationError(
  ctx: AdminUsersApiContext,
  authContext: RequestAuthContext,
  npubInput: string,
  admin: boolean,
  payload: Record<string, unknown>,
): Response | null {
  if (admin) {
    return null;
  }

  const normalized = normaliseNpub(npubInput);
  if (!normalized || !isConfiguredAdminNpub(ctx, normalized)) {
    return null;
  }
  if (isBootstrapAdminNpub(ctx, normalized)) {
    return Response.json({ error: "Bootstrap admins cannot be demoted while configured" }, { status: 400 });
  }
  if (wouldLeaveNoEffectiveAdmins(normalized, ctx.identityUserStore, ctx.bootstrapAdminNpubs ?? [], (npub) => isConfiguredAdminNpub(ctx, npub))) {
    return Response.json({ error: "Cannot demote the last admin" }, { status: 400 });
  }

  const viewerNpub = normaliseNpub(authContext.npub ?? null);
  if (viewerNpub && viewerNpub === normalized && payload.confirmSelfAdminDemotion !== true) {
    return Response.json({
      error: "Confirm self admin demotion before continuing",
      requiresConfirmation: "self-admin-demotion",
    }, { status: 409 });
  }
  return null;
}

function deleteUserError(
  ctx: AdminUsersApiContext,
  authContext: RequestAuthContext,
  npubInput: string,
  payload: Record<string, unknown>,
): Response | null {
  const normalized = normaliseNpub(npubInput);
  if (!normalized || !isConfiguredAdminNpub(ctx, normalized)) {
    return null;
  }
  if (isBootstrapAdminNpub(ctx, normalized)) {
    return Response.json({ error: "Bootstrap admins cannot be deleted while configured" }, { status: 400 });
  }
  if (wouldLeaveNoEffectiveAdmins(normalized, ctx.identityUserStore, ctx.bootstrapAdminNpubs ?? [], (npub) => isConfiguredAdminNpub(ctx, npub))) {
    return Response.json({ error: "Cannot delete the last admin" }, { status: 400 });
  }
  const viewerNpub = normaliseNpub(authContext.npub ?? null);
  if (viewerNpub && viewerNpub === normalized && payload.confirmSelfAdminDeletion !== true) {
    return Response.json({
      error: "Confirm self admin deletion before continuing",
      requiresConfirmation: "self-admin-deletion",
    }, { status: 409 });
  }
  return null;
}

function markBotIdentity(ctx: AdminUsersApiContext, npub: string): void {
  const bot = ctx.listBotIdentities?.().find((entry) => normaliseNpub(entry.botNpub) === normaliseNpub(npub));
  if (bot) ctx.identityUserStore.setRole(npub, "bot", true);
}

// ---------- Main handler ----------

export async function handleAdminUsersApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: AdminUsersApiContext,
): Promise<Response | null> {
  const pathname = url.pathname;

  if (pathname === "/api/admin/users" && method === "GET") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.AdminUsers, request, url, authContext);
    if (denied) return denied;
    const users = buildAdminUserList(ctx);
    return Response.json({ users });
  }

  if (pathname === "/api/admin/users" && method === "POST") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.AdminUsers, request, url, authContext);
    if (denied) return denied;
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
    const npubInput = ctx.normaliseOptionalString((payload as Record<string, unknown>).npub);
    if (!npubInput) {
      return Response.json({ error: "npub is required" }, { status: 400 });
    }
    const normalized = normaliseNpub(npubInput);
    if (!normalized) {
      return Response.json({ error: "Invalid npub" }, { status: 400 });
    }
    try {
      const record = payload as Record<string, unknown>;
      const approved = typeof record.approved === "boolean"
        ? record.approved
        : typeof record.onboarded === "boolean"
          ? record.onboarded
          : true;
      ctx.identityUserStore.setRole(npubInput, "approved", approved);
      markBotIdentity(ctx, npubInput);
      if (record.admin === true) {
        ctx.identityUserStore.setRole(npubInput, ADMIN_ROLE, true);
      }
      const users = buildAdminUserList(ctx);
      const user = users.find((entry) => entry.normalizedNpub === normalized) ?? null;
      return Response.json({ user, users }, { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (pathname === "/api/admin/users" && method === "PATCH") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.AdminUsers, request, url, authContext);
    if (denied) return denied;
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
    const npubInput = ctx.normaliseOptionalString((payload as Record<string, unknown>).npub);
    const record = payload as Record<string, unknown>;
    const accessValue = typeof record.approved === "boolean" ? record.approved : record.onboarded;
    const adminValue = typeof record.admin === "boolean" ? record.admin : null;
    if (!npubInput) {
      return Response.json({ error: "npub is required" }, { status: 400 });
    }
    if (typeof accessValue !== "boolean" && adminValue === null) {
      return Response.json({ error: "approved or admin flag is required" }, { status: 400 });
    }
    try {
      if (adminValue !== null) {
        const blocked = adminMutationError(ctx, authContext, npubInput, adminValue, record);
        if (blocked) return blocked;
        markBotIdentity(ctx, npubInput);
        ctx.identityUserStore.setRole(npubInput, ADMIN_ROLE, adminValue);
      }
      if (typeof accessValue === "boolean") {
        ctx.identityUserStore.setRole(npubInput, "approved", accessValue);
      }
      const users = buildAdminUserList(ctx);
      const normalizedNpub = normaliseNpub(npubInput);
      const user = normalizedNpub
        ? users.find((entry) => entry.normalizedNpub === normalizedNpub) ?? null
        : null;
      return Response.json({ user, users });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (pathname === "/api/admin/users/bulk" && method === "DELETE") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.AdminUsers, request, url, authContext);
    if (denied) return denied;
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
    const npubsInput = (payload as Record<string, unknown>).npubs;
    if (!Array.isArray(npubsInput) || npubsInput.length === 0) {
      return Response.json({ error: "npubs is required" }, { status: 400 });
    }
    const targets = new Map<string, string>();
    for (const entry of npubsInput) {
      const candidate = ctx.normaliseOptionalString(entry);
      if (!candidate) continue;
      const normalized = normaliseNpub(candidate);
      if (!normalized) continue;
      targets.set(normalized, candidate);
    }
    if (targets.size === 0) {
      return Response.json({ error: "At least one valid npub is required" }, { status: 400 });
    }
    const missing: string[] = [];
    const skippedAdmin: string[] = [];
    const skippedLastAdmin: string[] = [];
    let deletedCount = 0;
    for (const [normalized, original] of targets) {
      if (isBootstrapAdminNpub(ctx, normalized)) {
        skippedAdmin.push(original);
        continue;
      }
      if (isConfiguredAdminNpub(ctx, normalized) && wouldLeaveNoEffectiveAdmins(normalized, ctx.identityUserStore, ctx.bootstrapAdminNpubs ?? [], (npub) => isConfiguredAdminNpub(ctx, npub))) {
        skippedLastAdmin.push(original);
        continue;
      }
      try {
        await ctx.stopSessionsForUser(normalized);
        const deleted = ctx.identityUserStore.deleteUser(normalized);
        if (!deleted) {
          missing.push(original);
        } else {
          deletedCount += 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ error: `Failed to delete ${original}: ${message}` }, { status: 400 });
      }
    }
    const users = buildAdminUserList(ctx);
    return Response.json({
      users,
      summary: {
        requested: targets.size,
        deleted: deletedCount,
        missing,
        skippedAdmin,
        skippedLastAdmin,
      },
    });
  }

  if (pathname === "/api/admin/users" && method === "DELETE") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.AdminUsers, request, url, authContext);
    if (denied) return denied;
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
    const npubInput = ctx.normaliseOptionalString((payload as Record<string, unknown>).npub);
    if (!npubInput) {
      return Response.json({ error: "npub is required" }, { status: 400 });
    }
    const blocked = deleteUserError(ctx, authContext, npubInput, payload as Record<string, unknown>);
    if (blocked) return blocked;
    try {
      await ctx.stopSessionsForUser(npubInput);
      const deleted = ctx.identityUserStore.deleteUser(npubInput);
      if (!deleted) {
        return Response.json({ error: "User not found" }, { status: 404 });
      }
      const users = buildAdminUserList(ctx);
      return Response.json({ users });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (pathname === "/api/admin/users/nickname" && method === "POST") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.AdminUsers, request, url, authContext);
    if (denied) return denied;
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
    const record = payload as Record<string, unknown>;
    const npubInput = ctx.normaliseOptionalString(record.npub);
    if (!npubInput) {
      return Response.json({ error: "npub is required" }, { status: 400 });
    }
    const normalized = normaliseNpub(npubInput);
    if (!normalized) {
      return Response.json({ error: "Invalid npub" }, { status: 400 });
    }
    const nicknameValue = record.nickname;
    const nickname =
      nicknameValue === null
        ? null
        : typeof nicknameValue === "string"
          ? nicknameValue
          : typeof nicknameValue === "undefined"
            ? ""
            : String(nicknameValue);

    try {
      const updatedRecord = ctx.identityUserStore.setNickname(npubInput, nickname);
      const users = buildAdminUserList(ctx);
      const user = users.find((entry) => entry.normalizedNpub === updatedRecord.normalizedNpub) ?? null;
      return Response.json({ user, users }, { status: 200 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (pathname === "/api/admin/users/profile" && method === "POST") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.AdminUsers, request, url, authContext);
    if (denied) return denied;
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
    const npubInput = ctx.normaliseOptionalString((payload as Record<string, unknown>).npub);
    const force = (payload as Record<string, unknown>).refresh === true;
    if (!npubInput) {
      return Response.json({ error: "npub is required" }, { status: 400 });
    }
    const normalized = normaliseNpub(npubInput);
    if (!normalized) {
      return Response.json({ error: "Invalid npub" }, { status: 400 });
    }
    try {
      await ctx.resolveAndCacheNostrProfile(npubInput, { force, relays: ctx.config.connectRelays });
      const users = buildAdminUserList(ctx);
      const user = users.find((entry) => entry.normalizedNpub === normalized) ?? null;
      return Response.json({ user, users, pictureUrl: user?.pictureUrl ?? null }, { status: 200 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (pathname === "/api/admin/ports" && method === "POST") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.AdminUsers, request, url, authContext);
    if (denied) return denied;
    const adminNormalizedNpub = authContext.npub ? normaliseNpub(authContext.npub) : null;
    if (!adminNormalizedNpub) {
      return Response.json({ error: "Admin npub not found" }, { status: 400 });
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      payload = {};
    }

    const record = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
    const countInput = record.count;
    const count = typeof countInput === "number" && countInput > 0 ? Math.trunc(countInput) : 3;

    try {
      const updatedRecord = ctx.identityUserStore.addPortsToUser(adminNormalizedNpub, count);
      const users = buildAdminUserList(ctx);
      const user = users.find((entry) => entry.normalizedNpub === updatedRecord.normalizedNpub) ?? null;
      return Response.json({ user, users, newPorts: updatedRecord.ports.slice(-count) }, { status: 200 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (pathname === "/api/admin/users/ports" && method === "POST") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.AdminUsers, request, url, authContext);
    if (denied) return denied;

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const record = payload as Record<string, unknown>;
    const npubInput = ctx.normaliseOptionalString(record.npub);
    const countInput = record.count;

    if (!npubInput) {
      return Response.json({ error: "npub is required" }, { status: 400 });
    }

    const normalized = normaliseNpub(npubInput);
    if (!normalized) {
      return Response.json({ error: "Invalid npub" }, { status: 400 });
    }

    const count = typeof countInput === "number" && countInput > 0 ? Math.trunc(countInput) : 3;

    try {
      const updatedRecord = ctx.identityUserStore.addPortsToUser(npubInput, count);
      const users = buildAdminUserList(ctx);
      const user = users.find((entry) => entry.normalizedNpub === updatedRecord.normalizedNpub) ?? null;
      return Response.json({ user, users, newPorts: updatedRecord.ports.slice(-count) }, { status: 200 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  return null;
}

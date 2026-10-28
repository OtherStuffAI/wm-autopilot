import { isEffectiveAdminNpub, seedBootstrapAdminUsers, wouldLeaveNoEffectiveAdmins } from "../auth/admin-npubs";
import { isNpubInList, normaliseNpub } from "../identity/npub-utils";
import type { AdminUsersApiContext, AdminUserRecord } from "./admin-users-routes";

export function isConfiguredAdminNpub(ctx: AdminUsersApiContext, npub: string | null | undefined): boolean {
  if (ctx.isAdminNpub) {
    return ctx.isAdminNpub(npub);
  }
  return isEffectiveAdminNpub(npub, ctx.identityUserStore, ctx.bootstrapAdminNpubs ?? (ctx.adminNpub ? [ctx.adminNpub] : []));
}

export function isBootstrapAdminNpub(ctx: AdminUsersApiContext, npub: string | null | undefined): boolean {
  return isNpubInList(npub, ctx.bootstrapAdminNpubs ?? (ctx.adminNpub ? [ctx.adminNpub] : []));
}

export function seedBootstrapAdmins(ctx: AdminUsersApiContext): void {
  const bootstrapAdminNpubs = ctx.bootstrapAdminNpubs ?? (ctx.adminNpub ? [ctx.adminNpub] : []);
  if (bootstrapAdminNpubs.length === 0) {
    return;
  }
  seedBootstrapAdminUsers(ctx.identityUserStore, bootstrapAdminNpubs);
}

export function buildAdminUserList(ctx: AdminUsersApiContext): AdminUserRecord[] {
  seedBootstrapAdmins(ctx);
  const activeSessions = ctx.manager?.listSessions?.() ?? [];
  const identitySummaries = ctx.buildIdentitySummaries(activeSessions, ctx.adminNpub, { includeAll: true });
  const storedRecords = ctx.identityUserStore.listUsers();
  const storedMap = new Map(storedRecords.map((record) => [record.normalizedNpub, record] as const));
  const summaryMap = new Map<string, (typeof identitySummaries)[number]>();

  for (const summary of identitySummaries) {
    if (!summary.normalizedNpub || !summary.npub) {
      continue;
    }
    summaryMap.set(summary.normalizedNpub, summary);
    const existing = storedMap.get(summary.normalizedNpub);
    if (!existing) {
      continue;
    }
    try {
      ctx.identityUserStore.touchExisting(summary.npub, {
        lastSeenAt: summary.lastSeenAt ?? null,
      });
    } catch (error) {
      console.warn(`[admin] failed to sync identity ${summary.npub}:`, error);
    }
  }

  const bots = new Map((ctx.listBotIdentities?.() ?? []).map((bot) => [normaliseNpub(bot.botNpub), bot]));
  const finalRecords = ctx.identityUserStore.listUsers();
  const registered = new Set(finalRecords.map((record) => normaliseNpub(record.normalizedNpub || record.npub)));
  for (const [npub, bot] of bots) {
    if (!npub || !bot.active || registered.has(npub)) continue;
    finalRecords.push({ npub, normalizedNpub: npub, alias: bot.displayName || npub, nickname: null,
      pictureUrl: null, roles: [], onboardedAt: null, lastSeenAt: null, updatedAt: null, ports: [] });
  }
  const users: AdminUserRecord[] = finalRecords.map((record) => {
    const bot = bots.get(normaliseNpub(record.normalizedNpub || record.npub));
    const summary = summaryMap.get(record.normalizedNpub ?? "");
    const sessionCount = summary?.sessionIds.length ?? 0;
    const activeSessionCount = summary?.activeSessionIds.length ?? 0;
    const lastSeenAt = summary?.lastSeenAt ?? record.lastSeenAt ?? record.updatedAt ?? null;
    const admin = isConfiguredAdminNpub(ctx, record.normalizedNpub);
    const bootstrapAdmin = isBootstrapAdminNpub(ctx, record.normalizedNpub);
    const assignedAdmin = bootstrapAdmin || record.roles.includes("admin");
    return {
      bot: Boolean(bot) || record.roles.includes("bot"),
      displayName: bot?.displayName ?? null,
      active: bot?.active ?? !record.roles.includes("bot"),
      npub: record.npub,
      normalizedNpub: record.normalizedNpub,
      alias: record.alias,
      nickname: record.nickname ?? null,
      pictureUrl: record.pictureUrl ?? null,
      approved: record.roles.includes("approved") || record.roles.includes("onboard"),
      onboarded: record.roles.includes("approved") || record.roles.includes("onboard"),
      onboardedAt: record.onboardedAt,
      roles: [...record.roles],
      lastSeenAt,
      sessionCount,
      activeSessionCount,
      ports: record.ports,
      admin,
      assignedAdmin,
      bootstrapAdmin,
      canDemoteAdmin: assignedAdmin && !bootstrapAdmin && (!admin || !wouldLeaveNoEffectiveAdmins(
        record.normalizedNpub,
        ctx.identityUserStore,
        ctx.bootstrapAdminNpubs ?? [],
        (npub) => isConfiguredAdminNpub(ctx, npub),
      )),
    };
  });

  users.sort((a, b) => {
    const left = (a.nickname || a.alias || a.npub || "").toLowerCase();
    const right = (b.nickname || b.alias || b.npub || "").toLowerCase();
    if (left === right) {
      return (a.alias || "").localeCompare(b.alias || "");
    }
    return left.localeCompare(right);
  });
  return users;
}

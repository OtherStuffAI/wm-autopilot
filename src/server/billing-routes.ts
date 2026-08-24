import type { AccessAction } from "../auth/access-control";
import type { RequestAuthContext } from "../auth/request-context";
import type { TeamBillingService } from "../billing/team-billing-service";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

export interface BillingApiContext {
  billingService: TeamBillingService;
  ensureApiAccess: (action: AccessAction, request: Request, url: URL, authContext: RequestAuthContext) => Promise<Response | null>;
  AccessActions: { SystemManage: AccessAction };
}

const parseOptionalInt = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  return undefined;
};

export async function handleBillingApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: BillingApiContext,
): Promise<Response | null> {
  const pathname = url.pathname;
  if (!pathname.startsWith("/api/billing/")) {
    return null;
  }

  const denied = await ctx.ensureApiAccess(ctx.AccessActions.SystemManage, request, url, authContext);
  if (denied) {
    return denied;
  }

  if (pathname === "/api/billing/team" && method === "GET") {
    ctx.billingService.syncTeamMembers();
    return Response.json(ctx.billingService.getTeamConfigWithSummary());
  }

  if (pathname === "/api/billing/team" && (method === "PATCH" || method === "PUT")) {
    try {
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

      const configPatch: Partial<{
        externalTeamId: string | null;
        baseAllocationUsdCents: number;
        perMemberUsdCents: number;
        markupBps: number;
      }> = {};
      if (typeof record.externalTeamId === "string") {
        configPatch.externalTeamId = record.externalTeamId.trim() || null;
      } else if (record.externalTeamId === null) {
        configPatch.externalTeamId = null;
      }

      const baseAllocationUsdCents = parseOptionalInt(record.baseAllocationUsdCents);
      if (typeof baseAllocationUsdCents === "number") {
        configPatch.baseAllocationUsdCents = Math.max(0, baseAllocationUsdCents);
      }
      const perMemberUsdCents = parseOptionalInt(record.perMemberUsdCents);
      if (typeof perMemberUsdCents === "number") {
        configPatch.perMemberUsdCents = Math.max(0, perMemberUsdCents);
      }
      const markupBps = parseOptionalInt(record.markupBps);
      if (typeof markupBps === "number") {
        configPatch.markupBps = Math.max(0, markupBps);
      }

      const changedBudgetInputs = Object.keys(configPatch).length > 0;
      if (changedBudgetInputs) {
        ctx.billingService.updateTeamConfig(configPatch);
      }

      if (typeof record.useCredits === "boolean") {
        await ctx.billingService.setUseCredits(record.useCredits);
      } else if (changedBudgetInputs && ctx.billingService.isCreditsEnabled()) {
        await ctx.billingService.ensureProviderKeyForCredits();
      }

      return Response.json(ctx.billingService.getTeamConfigWithSummary());
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error("[billing-routes] PATCH /api/billing/team error:", detail);
      return Response.json({ error: "Failed to update team configuration" }, { status: 400 });
    }
  }

  if (pathname === "/api/billing/usage" && method === "GET") {
    const limit = parseOptionalInt(url.searchParams.get("limit")) ?? 100;
    const usage = ctx.billingService.getRecentUsage(limit);
    return Response.json({ usage, count: usage.length });
  }

  return null;
}

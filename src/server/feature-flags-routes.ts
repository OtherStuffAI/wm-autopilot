/**
 * API route handlers for feature-flag endpoints.
 * Extracted from server.ts to reduce file size.
 */

import { normaliseNpub } from "../identity/npub-utils";
import type { RequestAuthContext } from "../auth/request-context";
import type { AccessAction } from "../auth/access-control";
import {
  type FeatureFlagRecord,
  type FeatureFlagState,
  isFeatureFlagState,
  normaliseFeatureFlagKey,
  resolveFeatureFlagEffectiveState,
} from "../storage/feature-flag-store";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

const RETIRED_FEATURE_FLAG_KEYS = new Set(["task_listener_enabled"]);

function isRetiredFeatureFlag(key: string): boolean {
  return RETIRED_FEATURE_FLAG_KEYS.has(normaliseFeatureFlagKey(key));
}

// ---------- Serialisation helpers (also used by /api/config) ----------

export const serialiseFeatureFlag = (flag: FeatureFlagRecord, viewerIsAdmin: boolean) => ({
  key: flag.key,
  label: flag.label,
  description: flag.description,
  state: flag.state,
  effectiveState: resolveFeatureFlagEffectiveState(flag.state, viewerIsAdmin),
  updatedAt: flag.updatedAt,
  updatedBy: flag.updatedBy ?? null,
});

// ---------- Context supplied by server.ts ----------

export interface FeatureFlagsApiContext {
  featureFlagStore: {
    listFlags(): FeatureFlagRecord[];
    createFlag(input: {
      key: string;
      label: string;
      description: string | null;
      state: FeatureFlagState;
      updatedBy: string | null;
    }): FeatureFlagRecord;
    updateFlag(key: string, updates: {
      label?: string;
      description?: string | null;
      state?: FeatureFlagState;
      updatedBy?: string | null;
    }): FeatureFlagRecord;
  };
  viewerIsAdmin: boolean;
  ensureApiAccess: (action: AccessAction, request: Request, url: URL, authContext: RequestAuthContext) => Promise<Response | null>;
  AccessActions: { FeatureFlagsManage: AccessAction };
}

export function serialiseFeatureFlagsForViewer(
  featureFlagStore: FeatureFlagsApiContext["featureFlagStore"],
  viewerIsAdmin: boolean,
) {
  return featureFlagStore
    .listFlags()
    .filter((flag) => !isRetiredFeatureFlag(flag.key))
    .map((flag) => serialiseFeatureFlag(flag, viewerIsAdmin));
}

// ---------- Main handler ----------

export async function handleFeatureFlagsApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: FeatureFlagsApiContext,
): Promise<Response | null> {
  const pathname = url.pathname;

  // GET /api/feature-flags — list all flags
  if (pathname === "/api/feature-flags" && method === "GET") {
    const flags = serialiseFeatureFlagsForViewer(ctx.featureFlagStore, ctx.viewerIsAdmin);
    return Response.json({ flags });
  }

  // POST /api/feature-flags — create a flag
  if (pathname === "/api/feature-flags" && method === "POST") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.FeatureFlagsManage, request, url, authContext);
    if (denied) {
      return denied;
    }
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
    const key = normaliseFeatureFlagKey(typeof record.key === "string" ? record.key : "");
    const label = typeof record.label === "string" ? record.label.trim() : "";
    const description =
      typeof record.description === "string"
        ? record.description.trim()
        : record.description === null
          ? null
          : undefined;
    const stateInput = typeof record.state === "string" ? record.state.trim().toLowerCase() : "";
    const state: FeatureFlagState = isFeatureFlagState(stateInput) ? stateInput : "off";

    if (!key) {
      return Response.json({ error: "Feature flag key is required" }, { status: 400 });
    }
    if (isRetiredFeatureFlag(key)) {
      return Response.json({ error: "This feature flag is retired and has no runtime effect" }, { status: 410 });
    }
    if (!label) {
      return Response.json({ error: "Feature flag label is required" }, { status: 400 });
    }

    try {
      const created = ctx.featureFlagStore.createFlag({
        key,
        label,
        description: description === undefined ? null : description,
        state,
        updatedBy: normaliseNpub(authContext.npub ?? null),
      });
      const flags = serialiseFeatureFlagsForViewer(ctx.featureFlagStore, ctx.viewerIsAdmin);
      return Response.json({ flag: serialiseFeatureFlag(created, ctx.viewerIsAdmin), flags }, { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  // PATCH /api/feature-flags/:key — update a flag
  if (pathname.startsWith("/api/feature-flags/") && method === "PATCH") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.FeatureFlagsManage, request, url, authContext);
    if (denied) {
      return denied;
    }

    const parts = pathname.split("/").filter(Boolean);
    if (parts.length !== 3 || !parts[2]) {
      return Response.json({ error: "Feature flag key is required" }, { status: 400 });
    }
    const key = normaliseFeatureFlagKey(parts[2]);
    if (!key) {
      return Response.json({ error: "Invalid feature flag key" }, { status: 400 });
    }
    if (isRetiredFeatureFlag(key)) {
      return Response.json({ error: "This feature flag is retired and has no runtime effect" }, { status: 410 });
    }

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
    const updates: Record<string, unknown> = {};
    if (Object.prototype.hasOwnProperty.call(record, "label")) {
      const label = typeof record.label === "string" ? record.label.trim() : "";
      if (!label) {
        return Response.json({ error: "Feature flag label is required" }, { status: 400 });
      }
      updates.label = label;
    }

    if (Object.prototype.hasOwnProperty.call(record, "description")) {
      const description =
        typeof record.description === "string"
          ? record.description.trim()
          : record.description === null
            ? null
            : undefined;
      updates.description = description;
    }

    if (Object.prototype.hasOwnProperty.call(record, "state")) {
      const stateInput = typeof record.state === "string" ? record.state.trim().toLowerCase() : "";
      if (!isFeatureFlagState(stateInput)) {
        return Response.json({ error: "Invalid feature flag state" }, { status: 400 });
      }
      updates.state = stateInput;
    }

    if (Object.keys(updates).length === 0) {
      return Response.json({ error: "No updates provided" }, { status: 400 });
    }

    try {
      const updated = ctx.featureFlagStore.updateFlag(key, {
        label: updates.label as string | undefined,
        description: updates.description as string | null | undefined,
        state: updates.state as FeatureFlagState | undefined,
        updatedBy: normaliseNpub(authContext.npub ?? null),
      });
      const flags = serialiseFeatureFlagsForViewer(ctx.featureFlagStore, ctx.viewerIsAdmin);
      return Response.json({ flag: serialiseFeatureFlag(updated, ctx.viewerIsAdmin), flags });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  return null;
}

import type { AccessAction } from "../auth/access-control";
import type { RequestAuthContext } from "../auth/request-context";
import type { InstanceSettingsService } from "../settings/instance-settings-service";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

export interface InstanceSettingsRoutesContext {
  service: InstanceSettingsService;
  ensureApiAccess: (
    action: AccessAction,
    request: Request,
    url: URL,
    authContext: RequestAuthContext,
  ) => Promise<Response | null>;
  AccessActions: { SystemManage: AccessAction };
}

export async function handleInstanceSettingsApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: InstanceSettingsRoutesContext,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/instance-settings")) {
    return null;
  }

  const denied = await ctx.ensureApiAccess(ctx.AccessActions.SystemManage, request, url, authContext);
  if (denied) return denied;

  if (url.pathname === "/api/instance-settings" && method === "GET") {
    const preview = await ctx.service.previewEnvImport(process.env);
    return Response.json(preview);
  }

  if (url.pathname === "/api/instance-settings/import" && method === "POST") {
    const payload = await readJsonRecord(request);
    if (payload instanceof Response) return payload;
    const keys = parseStringArray(payload.keys);
    if (keys.length === 0) {
      return Response.json({ error: "keys are required" }, { status: 400 });
    }
    const result = ctx.service.importFromEnvironment(keys, process.env);
    return Response.json(result);
  }

  if (url.pathname === "/api/instance-settings/backup-env" && method === "POST") {
    try {
      return Response.json(await ctx.service.backupEnvFile());
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
  }

  if (url.pathname === "/api/instance-settings/cleanup-env" && method === "POST") {
    const payload = await readJsonRecord(request);
    if (payload instanceof Response) return payload;
    const keys = parseStringArray(payload.keys);
    if (keys.length === 0) {
      return Response.json({ error: "keys are required" }, { status: 400 });
    }
    try {
      return Response.json(await ctx.service.cleanupEnvFile(keys, process.env));
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
  }

  const parts = url.pathname.split("/");
  const settingKey = decodeURIComponent(parts.slice(3).join("/"));
  if (settingKey && (method === "PUT" || method === "PATCH")) {
    const payload = await readJsonRecord(request);
    if (payload instanceof Response) return payload;
    const value = typeof payload.value === "string" ? payload.value.trim() : "";
    if (!value) {
      return Response.json({ error: "value is required" }, { status: 400 });
    }
    try {
      const record = ctx.service.set(settingKey, value);
      return Response.json({
        success: true,
        key: record.key,
        source: record.source,
        updatedAt: record.updatedAt,
      });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
  }

  if (settingKey && method === "DELETE") {
    try {
      const deleted = ctx.service.delete(settingKey);
      return Response.json({ success: true, key: settingKey, deleted });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}

async function readJsonRecord(request: Request): Promise<Record<string, unknown> | Response> {
  try {
    const payload = await request.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
    return payload as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
  }
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

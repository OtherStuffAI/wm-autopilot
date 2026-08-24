import type { AccessAction } from "../auth/access-control";
import type { RequestAuthContext } from "../auth/request-context";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

const DEFAULT_AGENT_SETTING_KEY = "default_agent";
const SENSITIVE_SETTING_TERMS = ["key", "secret", "token", "password"];

export interface UserSettingsRoutesContext {
  agents: Record<string, { label: string }>;
  userSettingsStore: {
    getAll: (npub: string) => Record<string, string>;
    set: (npub: string, key: string, value: string) => void;
    delete: (npub: string, key: string) => void;
  };
  ensureApiAccess: (
    action: AccessAction,
    request: Request,
    url: URL,
    authContext: RequestAuthContext,
  ) => Promise<Response | null>;
  AccessActions: {
    SessionsManage: AccessAction;
  };
}

function maskSettingValue(key: string, value: string): string {
  const lowerKey = key.toLowerCase();
  const isSensitive = SENSITIVE_SETTING_TERMS.some((term) => lowerKey.includes(term));
  if (!isSensitive) {
    return value;
  }
  return value.length > 8 ? `${value.slice(0, 4)}..${value.slice(-4)}` : "****";
}

function maskSensitiveSettings(settings: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(settings)) {
    masked[key] = maskSettingValue(key, value);
  }
  return masked;
}

export async function handleUserSettingsApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: UserSettingsRoutesContext,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/user/settings")) {
    return null;
  }

  const denied = await ctx.ensureApiAccess(ctx.AccessActions.SessionsManage, request, url, authContext);
  if (denied) return denied;

  const viewerNpub = authContext.npub;
  if (!viewerNpub) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const settingsParts = url.pathname.split("/");
  const settingKey = settingsParts[4];

  if (method === "GET" && !settingKey) {
    const settings = ctx.userSettingsStore.getAll(viewerNpub);
    return Response.json({ settings: maskSensitiveSettings(settings) });
  }

  if (method === "PUT" && settingKey) {
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const record = payload as Record<string, unknown>;
    const value = typeof record.value === "string" ? record.value.trim() : "";
    if (!value) {
      return Response.json({ error: "value is required" }, { status: 400 });
    }

    if (settingKey === DEFAULT_AGENT_SETTING_KEY) {
      const normalizedValue = value.toLowerCase();
      if (!(normalizedValue in ctx.agents)) {
        const supportedAgents = Object.keys(ctx.agents).join(", ");
        return Response.json({ error: `value must be one of: ${supportedAgents}` }, { status: 400 });
      }
      ctx.userSettingsStore.set(viewerNpub, settingKey, normalizedValue);
      return Response.json({ success: true, key: settingKey, value: normalizedValue });
    }

    ctx.userSettingsStore.set(viewerNpub, settingKey, value);
    return Response.json({ success: true, key: settingKey });
  }

  if (method === "DELETE" && settingKey) {
    ctx.userSettingsStore.delete(viewerNpub, settingKey);
    return Response.json({ success: true, key: settingKey, deleted: true });
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}

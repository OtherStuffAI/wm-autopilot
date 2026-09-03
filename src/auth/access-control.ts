import type { RequestAuthContext } from "./request-context";

export const AccessActions = {
  SessionsManage: "sessions:manage",
  SessionsRead: "sessions:read",
  FilesRead: "files:read",
  FilesWrite: "files:write",
  AppsLifecycle: "apps:lifecycle",
  AppsManage: "apps:manage",
  AppsRead: "apps:read",
  ProjectsManage: "projects:manage",
  UiRestricted: "ui:restricted",
  AdminUsers: "admin:users",
  FeatureFlagsManage: "feature-flags:manage",
  SystemManage: "system:manage",
  TerminalAccess: "terminal:access",
  TodosManage: "todos:manage",
  DeploymentsManage: "deployments:manage",
  DelegationsManage: "delegations:manage",
} as const;

export type AccessAction = (typeof AccessActions)[keyof typeof AccessActions];

export interface AccessContext {
  action: AccessAction;
  request: Request;
  url: URL;
  auth: RequestAuthContext;
  params?: Record<string, unknown>;
}

export interface AccessDecision {
  allowed: boolean;
  reason?: string;
  status?: number;
  headers?: Record<string, string>;
}

export type AccessRule = (context: AccessContext) => Promise<AccessDecision | null | void> | AccessDecision | null | void;

const policyRules = new Map<AccessAction, AccessRule[]>();

export const clearAccessRules = () => {
  policyRules.clear();
};

export const registerAccessRule = (action: AccessAction, rule: AccessRule) => {
  const existing = policyRules.get(action);
  if (existing) {
    existing.push(rule);
    return;
  }
  policyRules.set(action, [rule]);
};

const normaliseDecision = (decision: AccessDecision): AccessDecision => {
  if (decision.allowed) {
    return { allowed: true, reason: decision.reason, headers: decision.headers };
  }
  return {
    allowed: false,
    reason: decision.reason ?? "forbidden",
    status: decision.status ?? 403,
    headers: decision.headers,
  };
};

export const allow = (overrides: Partial<Omit<AccessDecision, "allowed">> = {}): AccessDecision => ({
  allowed: true,
  ...overrides,
});

export const deny = (
  reason = "forbidden",
  status = 403,
  overrides: Partial<Omit<AccessDecision, "allowed" | "reason" | "status">> = {},
): AccessDecision => ({
  allowed: false,
  reason,
  status,
  ...overrides,
});

export const evaluateAccess = async (
  action: AccessAction,
  context: Omit<AccessContext, "action">,
): Promise<AccessDecision> => {
  const rules = policyRules.get(action);
  if (!rules || rules.length === 0) {
    return allow();
  }

  const enrichedContext: AccessContext = {
    ...context,
    action,
  };

  for (const rule of rules) {
    const decision = await rule(enrichedContext);
    if (!decision) {
      continue;
    }
    const normalised = normaliseDecision(decision);
    if (!normalised.allowed) {
      return normalised;
    }
  }

  return allow();
};

export interface RequireAuthenticationOptions {
  reason?: string;
  status?: number;
  allowNip98?: boolean;
}

export const requireAuthentication = (options: RequireAuthenticationOptions = {}): AccessRule => {
  const reason = options.reason ?? "auth-required";
  const status = options.status ?? 401;
  return (context) => {
    if (context.auth.session) {
      return allow();
    }
    if (options.allowNip98 && context.auth.npub) {
      return allow();
    }
    return deny(reason, status);
  };
};

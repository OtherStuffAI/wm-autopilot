import { describe, expect, test } from "bun:test";

import { createOwnerScopedAuthContext, DelegationScopes, type OwnerAccessResolution } from "../auth/delegation-access";
import type { RequestAuthContext } from "../auth/request-context";
import type { WorkspaceDelegationRecord } from "../storage/workspace-delegation-store";
import {
  handleOwnerSpaceApi,
  resolveOwnerAgentChatScope,
  resolveOwnerAppsScope,
  resolveOwnerWappsScope,
  type OwnerSpaceRoutesContext,
} from "./owner-space-routes";

describe("owner-space executable authority", () => {
  test("maps app operations to granular delegation scopes", async () => {
    const action = (value: string) => new Request("http://localhost/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: value }),
    });
    expect(await resolveOwnerAppsScope(action("start"), "POST", "/apps/app-1/actions")).toBe(DelegationScopes.AppsOperate);
    expect(await resolveOwnerAppsScope(action("build"), "POST", "/apps/app-1/actions")).toBe(DelegationScopes.AppsBuild);
    expect(await resolveOwnerAppsScope(new Request("http://localhost/apps"), "PUT", "/apps/app-1")).toBe(DelegationScopes.AppsConfigure);
    expect(await resolveOwnerAppsScope(new Request("http://localhost/apps"), "GET", "/apps")).toBe(DelegationScopes.AppsRead);
    expect(await resolveOwnerAppsScope(action("deploy"), "POST", "/apps/app-1/deploy-to-caprover")).toBe(DelegationScopes.DeploymentsManage);
  });

  test("maps WApp operations to narrow delegation scopes", () => {
    expect(resolveOwnerWappsScope("GET", "/wapps")).toBe(DelegationScopes.WappsRead);
    expect(resolveOwnerWappsScope("POST", "/wapps/templates/create")).toBe(DelegationScopes.WappsInstall);
    expect(resolveOwnerWappsScope("POST", "/wapps")).toBe(DelegationScopes.WappsAssign);
    expect(resolveOwnerWappsScope("PATCH", "/wapps/wapp-1")).toBe(DelegationScopes.WappsAssign);
  });

  test("maps Agent Dispatch reads and mutations to session delegation scopes", () => {
    expect(resolveOwnerAgentChatScope("GET")).toBe(DelegationScopes.SessionsRead);
    expect(resolveOwnerAgentChatScope("POST")).toBe(DelegationScopes.SessionsManage);
    expect(resolveOwnerAgentChatScope("PATCH")).toBe(DelegationScopes.SessionsManage);
    expect(resolveOwnerAgentChatScope("DELETE")).toBe(DelegationScopes.SessionsManage);
  });

  test("preserves the real signer while attaching verified delegation evidence", () => {
    const auth: RequestAuthContext = {
      npub: "npub1agent",
      actorNpub: "npub1agent",
      signerNpub: "npub1agent",
      subjectNpub: "npub1agent",
      targetOwnerNpub: "npub1agent",
      session: null,
    };
    const access: OwnerAccessResolution = {
      ownerNpub: "npub1admin",
      subjectNpub: "npub1agent",
      signerNpub: "npub1agent",
      selfAccess: false,
      delegation: {
        id: "delegation-1",
        ownerNpub: "npub1admin",
        delegateNpub: "npub1agent",
        scopes: ["apps:operate"],
        resourceFilters: null,
        billingMode: "owner",
        spendLimitSats: null,
        createdAt: 1,
        expiresAt: null,
        revokedAt: null,
        signedPayload: "signed",
        signature: "signature",
        eventId: null,
        createdBy: "npub1admin",
      },
    };
    const scoped = createOwnerScopedAuthContext(auth, "npub1admin", access, "apps:operate");
    expect(scoped.npub).toBe("npub1agent");
    expect(scoped.signerNpub).toBe("npub1agent");
    expect(scoped.targetOwnerNpub).toBe("npub1admin");
    expect(scoped.delegateRelationshipId).toBe("delegation-1");
  });
});

describe("owner-space scheduler delegation", () => {
  const owner = "npub1admin";
  const delegate = "npub1agent";
  const auth: RequestAuthContext = {
    npub: delegate,
    actorNpub: delegate,
    signerNpub: delegate,
    subjectNpub: delegate,
    targetOwnerNpub: delegate,
    session: null,
    authMethod: "nip98",
  };

  function grant(
    scopes: string[],
    resourceFilters: WorkspaceDelegationRecord["resourceFilters"] = { pathPrefixes: ["/allowed"] },
  ): WorkspaceDelegationRecord {
    return {
      id: "delegation-1",
      ownerNpub: owner,
      delegateNpub: delegate,
      scopes,
      resourceFilters,
      billingMode: "owner",
      spendLimitSats: null,
      createdAt: 1,
      expiresAt: null,
      revokedAt: null,
      signedPayload: "signed",
      signature: "signature",
      eventId: null,
      createdBy: owner,
    };
  }

  function context(input: {
    activeGrant?: WorkspaceDelegationRecord | null;
    jobOwner?: string;
    workingDirectory?: string;
    onAccess?: (authContext: RequestAuthContext) => void;
    onAudit?: OwnerSpaceRoutesContext["auditExecution"];
    onScheduler?: (request: Request, url: URL, method: string) => Promise<Response>;
    onSession?: (request: Request, url: URL, method: string, authContext: RequestAuthContext) => Promise<Response>;
    includeAgentChat?: boolean;
  } = {}): OwnerSpaceRoutesContext {
    const activeGrant = input.activeGrant === undefined
      ? grant([DelegationScopes.SessionsRead, DelegationScopes.SessionsCreate, DelegationScopes.SessionsManage])
      : input.activeGrant;
    return {
      workspaceDelegationStore: {
        findActiveDelegation: (candidateOwner: string, candidateDelegate: string, scope?: string) => {
          if (!activeGrant || candidateOwner !== owner || candidateDelegate !== delegate) return null;
          return !scope || activeGrant.scopes.includes(scope) ? activeGrant : null;
        },
      } as OwnerSpaceRoutesContext["workspaceDelegationStore"],
      resolveWorkspace: () => ({
        ownerNpub: owner,
        docsRoot: "/",
        docsRootBoundary: "/",
        aliasDirectory: "/allowed",
        defaultDirectory: "/allowed",
        allowedDirectories: ["/allowed"],
        isAdmin: true,
      }),
      schedulerStore: {
        getJob: () => ({
          id: "trigger-1",
          userNpub: input.jobOwner ?? owner,
          workingDirectory: input.workingDirectory ?? "/allowed/book-of-sand",
          watchDirectory: null,
        }),
      } as unknown as OwnerSpaceRoutesContext["schedulerStore"],
      ensureSessionsAccess: async (_request, _url, authContext) => {
        input.onAccess?.(authContext);
        return null;
      },
      auditExecution: input.onAudit,
      schedulerApiHandler: input.onScheduler ?? (async (_request, _url, method) =>
        method === "DELETE"
          ? new Response(null, { status: 204 })
          : Response.json({ ok: true })),
      sessionApiHandler: input.onSession,
      buildAppsContext: (() => ({})) as unknown as OwnerSpaceRoutesContext["buildAppsContext"],
      docsApiContext: {} as OwnerSpaceRoutesContext["docsApiContext"],
      listDirectories: async () => ({}),
      createDirectoryEntry: async () => ({}),
      agentChatApiContext: input.includeAgentChat
        ? {
            manager: {
              listBackendConnectionsForManager: () => [],
              listForManager: () => [],
            },
            adminNpub: owner,
            sharedAgentDispatch: true,
            isApprovedContext: () => true,
          } as unknown as OwnerSpaceRoutesContext["agentChatApiContext"]
        : undefined,
    };
  }

  test("forwards delegated owner-space Agent Dispatch reads", async () => {
    const request = new Request("http://localhost/api/owners/npub1admin/agent-chat/subscriptions");
    const response = await handleOwnerSpaceApi(
      request,
      new URL(request.url),
      "GET",
      auth,
      context({
        activeGrant: grant([DelegationScopes.SessionsRead]),
        includeAgentChat: true,
      }),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      permissions: { shared: true, canManage: true },
      subscriptions: [],
    });
  });

  test("forwards delegated owner-space session renames with sessions:manage evidence", async () => {
    let observedUrl = "";
    let observedAuth: RequestAuthContext | null = null;
    const request = new Request("http://localhost/api/owners/npub1admin/sessions/session-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Descriptive session" }),
    });
    const response = await handleOwnerSpaceApi(request, new URL(request.url), "PATCH", auth, context({
      activeGrant: grant([DelegationScopes.SessionsManage]),
      onSession: async (_request, url, _method, authContext) => {
        observedUrl = url.pathname;
        observedAuth = authContext;
        return Response.json({ id: "session-1", name: "Descriptive session" });
      },
    }));
    expect(response?.status).toBe(200);
    expect(observedUrl).toBe("/api/sessions/session-1");
    expect(observedAuth?.targetOwnerNpub).toBe(owner);
    expect(observedAuth?.delegateRelationshipId).toBe("delegation-1");
    expect(observedAuth?.delegateExecutionScope).toBe(DelegationScopes.SessionsManage);
  });

  test("authorizes delegated create, update, and delete with owner and delegate audit context", async () => {
    const observed: RequestAuthContext[] = [];
    const ctx = context({ onAccess: (value) => observed.push(value) });
    const cases = [
      ["POST", "/api/owners/npub1admin/scheduler/jobs", { workingDirectory: "/allowed/new-trigger" }],
      ["PATCH", "/api/owners/npub1admin/scheduler/jobs/trigger-1", { initialPrompt: "updated" }],
      ["DELETE", "/api/owners/npub1admin/scheduler/jobs/trigger-1", undefined],
    ] as const;
    for (const [method, path, body] of cases) {
      const request = new Request(`http://localhost${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const response = await handleOwnerSpaceApi(request, new URL(request.url), method, auth, ctx);
      expect(response?.status).toBe(method === "DELETE" ? 204 : 200);
    }
    expect(observed.map((value) => value.delegateExecutionScope)).toEqual([
      DelegationScopes.SessionsCreate,
      DelegationScopes.SessionsManage,
      DelegationScopes.SessionsManage,
    ]);
    for (const value of observed) {
      expect(value.signerNpub).toBe(delegate);
      expect(value.targetOwnerNpub).toBe(owner);
      expect(value.delegatedOwnerNpub).toBe(owner);
      expect(value.delegateRelationshipId).toBe("delegation-1");
    }
  });

  test("denies missing/inactive, wrong-owner, and wrong-scope delegations with actionable errors", async () => {
    const noGrant = context({ activeGrant: null });
    const update = new Request("http://localhost/api/owners/npub1admin/scheduler/jobs/trigger-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initialPrompt: "updated" }),
    });
    const noGrantResponse = await handleOwnerSpaceApi(update, new URL(update.url), "PATCH", auth, noGrant);
    expect(noGrantResponse?.status).toBe(403);
    expect(await noGrantResponse?.json()).toEqual({
      error: "active-owner-delegation-required",
      requiredScope: DelegationScopes.SessionsManage,
    });

    const wrongScopeResponse = await handleOwnerSpaceApi(
      update,
      new URL(update.url),
      "PATCH",
      auth,
      context({ activeGrant: grant([DelegationScopes.SessionsRead]) }),
    );
    expect(await wrongScopeResponse?.json()).toEqual({
      error: "delegation-scope-required",
      requiredScope: DelegationScopes.SessionsManage,
    });

    const wrongOwnerAuth = { ...auth, npub: "npub1other", subjectNpub: "npub1other", signerNpub: "npub1other" };
    const wrongOwnerResponse = await handleOwnerSpaceApi(update, new URL(update.url), "PATCH", wrongOwnerAuth, context());
    expect(await wrongOwnerResponse?.json()).toMatchObject({ error: "active-owner-delegation-required" });
  });

  test("denies triggers outside delegated id and path filters", async () => {
    const audits: Array<Record<string, unknown>> = [];
    const update = new Request("http://localhost/api/owners/npub1admin/scheduler/jobs/trigger-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initialPrompt: "updated" }),
    });
    const triggerResponse = await handleOwnerSpaceApi(
      update,
      new URL(update.url),
      "PATCH",
      auth,
      context({
        activeGrant: grant([DelegationScopes.SessionsManage], { triggerIds: ["trigger-2"] }),
        onAudit: (entry) => audits.push(entry),
      }),
    );
    expect(await triggerResponse?.json()).toMatchObject({
      error: "trigger-outside-delegated-resource-filters",
      filter: "triggerIds",
    });

    const pathResponse = await handleOwnerSpaceApi(
      update,
      new URL(update.url),
      "PATCH",
      auth,
      context({ workingDirectory: "/denied/book-of-sand" }),
    );
    expect(await pathResponse?.json()).toEqual({
      error: "trigger-outside-delegated-resource-filters",
      filter: "workingDirectory",
    });
    expect(audits[0]).toMatchObject({
      actorNpub: delegate,
      ownerNpub: owner,
      delegationId: "delegation-1",
      scope: DelegationScopes.SessionsManage,
      outcome: "denied",
    });
  });
});

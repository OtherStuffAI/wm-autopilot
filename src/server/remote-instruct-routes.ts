import type { AccessAction } from "../auth/access-control";
import type { RequestAuthContext } from "../auth/request-context";
import {
  buildRemoteInstructVariables,
  loadRemoteInstruct,
  readRemoteInstructTemplate,
  RemoteInstructConfigError,
  writeRemoteInstructTemplate,
} from "../remote-instruct/remote-instruct";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

export interface RemoteInstructRoutesContext {
  promptPath: string;
  config: {
    baseUrl: string;
    agents: Record<string, { label: string }>;
  };
  getDefaultWorkdir: (authContext: RequestAuthContext) => string;
  projectReference: string | null;
  resolveNip98AuthContext: (
    request: Request,
    url: URL,
    authContext: RequestAuthContext,
  ) => Promise<RequestAuthContext>;
  ensureApiAccess: (
    action: AccessAction,
    request: Request,
    url: URL,
    authContext: RequestAuthContext,
  ) => Promise<Response | null>;
  ensureTemplateManageAccess: (
    request: Request,
    url: URL,
    authContext: RequestAuthContext,
  ) => Promise<Response | null>;
  AccessActions: {
    SessionsManage: AccessAction;
  };
}

function methodNotAllowed(allowed: string): Response {
  return Response.json(
    { error: "method-not-allowed" },
    { status: 405, headers: { allow: allowed } },
  );
}

function getRemoteInstructTemplatePayload(input: {
  template: string;
  promptPath: string;
  ctx: RemoteInstructRoutesContext;
  authContext: RequestAuthContext;
}) {
  const variables = buildRemoteInstructVariables({
    autopilotUrl: input.ctx.config.baseUrl,
    defaultWorkdir: input.ctx.getDefaultWorkdir(input.authContext),
    agentTypes: Object.keys(input.ctx.config.agents),
    viewerNpub: input.authContext.npub,
    authMethod: input.authContext.authMethod ?? null,
    projectReference: input.ctx.projectReference,
  });
  return {
    ok: true,
    name: "Remote Instruct",
    template: input.template,
    promptPath: input.promptPath,
    variables,
  };
}

async function readJsonPayload(request: Request): Promise<Record<string, unknown> | Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
  }
  return payload as Record<string, unknown>;
}

export async function handleRemoteInstructApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: RemoteInstructRoutesContext,
): Promise<Response | null> {
  if (url.pathname !== "/api/remote-instruct" && url.pathname !== "/api/remote-instruct/template") {
    return null;
  }

  if (method === "OPTIONS") {
    const allow = url.pathname === "/api/remote-instruct/template" ? "GET, PUT" : "GET";
    return new Response(null, { status: 204, headers: { allow } });
  }

  if (url.pathname === "/api/remote-instruct/template") {
    const remoteAuthContext = await ctx.resolveNip98AuthContext(request, url, authContext);
    const denied = await ctx.ensureTemplateManageAccess(request, url, remoteAuthContext);
    if (denied) {
      return denied;
    }
    if (!remoteAuthContext.npub) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }

    if (method === "GET" || method === "HEAD") {
      try {
        const current = await readRemoteInstructTemplate(ctx.promptPath);
        return Response.json(getRemoteInstructTemplatePayload({
          template: current.template,
          promptPath: current.promptPath,
          ctx,
          authContext: remoteAuthContext,
        }));
      } catch (error) {
        if (error instanceof RemoteInstructConfigError) {
          return Response.json(
            { error: "remote-instruct-not-configured", message: error.message },
            { status: 503 },
          );
        }
        throw error;
      }
    }

    if (method === "PUT") {
      const payload = await readJsonPayload(request);
      if (payload instanceof Response) {
        return payload;
      }
      const template = typeof payload.template === "string" ? payload.template : null;
      if (template === null) {
        return Response.json({ error: "template is required" }, { status: 400 });
      }
      const saved = await writeRemoteInstructTemplate(ctx.promptPath, template);
      return Response.json(getRemoteInstructTemplatePayload({
        template: saved.template,
        promptPath: saved.promptPath,
        ctx,
        authContext: remoteAuthContext,
      }));
    }

    return methodNotAllowed("GET, PUT");
  }

  if (method !== "GET" && method !== "HEAD") {
    return methodNotAllowed("GET");
  }

  const remoteAuthContext = await ctx.resolveNip98AuthContext(request, url, authContext);
  const denied = await ctx.ensureApiAccess(
    ctx.AccessActions.SessionsManage,
    request,
    url,
    remoteAuthContext,
  );
  if (denied) {
    return denied;
  }

  if (!remoteAuthContext.npub) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const variables = buildRemoteInstructVariables({
      autopilotUrl: ctx.config.baseUrl,
      defaultWorkdir: ctx.getDefaultWorkdir(remoteAuthContext),
      agentTypes: Object.keys(ctx.config.agents),
      viewerNpub: remoteAuthContext.npub,
      authMethod: remoteAuthContext.authMethod ?? null,
      projectReference: ctx.projectReference,
    });
    const rendered = await loadRemoteInstruct({
      promptPath: ctx.promptPath,
      variables,
    });

    return Response.json({
      ok: true,
      name: "Remote Instruct",
      version: 1,
      content: rendered.content,
      variables: rendered.variables,
      missingVariables: rendered.missingVariables,
    });
  } catch (error) {
    if (error instanceof RemoteInstructConfigError) {
      return Response.json(
        { error: "remote-instruct-not-configured", message: error.message },
        { status: 503 },
      );
    }
    throw error;
  }
}

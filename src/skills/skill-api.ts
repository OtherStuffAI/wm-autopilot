import type { RequestAuthContext } from "../auth/request-context";
import { getEffectiveOwnerNpub } from "../auth/effective-owner";
import type { WorkspaceScope } from "../workspaces/workspace-scope";
import type { SkillManager } from "./skill-manager";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";
export interface SkillApiContext { manager: SkillManager; resolveWorkspace(auth: RequestAuthContext): WorkspaceScope }

const body = async (request: Request) => {
  try { return await request.json() as Record<string, unknown>; }
  catch { throw new Error("Invalid JSON payload"); }
};
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];

export async function handleSkillApi(request: Request, url: URL, method: Method, auth: RequestAuthContext, context: SkillApiContext): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/skills")) return null;
  const owner = getEffectiveOwnerNpub(auth);
  if (!owner) return Response.json({ error: "Authentication required" }, { status: 401 });
  const workspace = context.resolveWorkspace(auth);
  const parts = url.pathname.split("/").filter(Boolean).slice(2).map(decodeURIComponent);
  try {
    if (parts.length === 0 && method === "GET") return Response.json(context.manager.list(owner));
    if (parts[0] === "sources" && parts.length === 1 && method === "GET") return Response.json({ sources: context.manager.store.listSources(owner) });
    if (parts[0] === "sources" && parts.length === 1 && method === "POST") {
      const input = await body(request);
      const source = context.manager.registerSource(owner, {
        name: String(input.name ?? ""), sourceClass: String(input.sourceClass ?? "user") as "wingman" | "third_party" | "user",
        sourceKind: String(input.sourceKind ?? "local") as "git" | "local", location: String(input.location ?? ""),
        ref: typeof input.ref === "string" ? input.ref : null, defaultEnabled: input.defaultEnabled === true,
      }, workspace.isAdmin);
      return Response.json({ source }, { status: 201 });
    }
    if (parts[0] === "sources" && parts[1] && parts.length === 2 && method === "GET") {
      const source = context.manager.store.getSource(parts[1]);
      if (!source || (source.ownerNpub !== owner && source.ownerNpub !== "wingman-system")) throw new Error("Source not found");
      return Response.json({ source, revisions: context.manager.store.listRevisions(owner).filter((revision) => revision.sourceId === source.id) });
    }
    if (parts[0] === "sources" && parts[1] && parts.length === 2 && method === "DELETE") {
      const source = context.manager.store.getSource(parts[1]);
      if (!source || source.ownerNpub !== owner) throw new Error("Source not found");
      return Response.json({ removed: context.manager.store.deleteSource(source.id) });
    }
    if (parts[0] === "sources" && parts[1] && parts[2] === "fetch" && method === "POST") return Response.json({ source: await context.manager.fetch(owner, parts[1], workspace.allowedDirectories, workspace.isAdmin) });
    if (parts[0] === "sources" && parts[1] && parts[2] === "import" && method === "POST") return Response.json(await context.manager.import(owner, parts[1], workspace.allowedDirectories, workspace.isAdmin));
    if (parts[0] === "sources" && parts[1] && parts[2] === "activate" && method === "POST") {
      const input = await body(request);
      return Response.json(context.manager.activate(owner, parts[1], String(input.importId ?? ""), workspace.isAdmin));
    }
    if (parts[0] === "catalog" && parts.length === 1 && method === "GET") return Response.json({ catalog: context.manager.list(owner).catalog });
    if (parts[0] === "catalog" && parts[1] && parts.length === 2 && method === "GET") {
      const skill = context.manager.list(owner).catalog.find((entry) => entry.skillId === parts[1]);
      if (!skill) throw new Error("Skill not found");
      return Response.json({ skill, revisions: context.manager.store.listRevisions(owner, skill.skillId), deployments: context.manager.store.listDeployments(owner, skill.skillId) });
    }
    if (parts[0] === "catalog" && parts[1] && parts[2] === "revisions" && method === "GET") return Response.json({ revisions: context.manager.store.listRevisions(owner, parts[1]) });
    if (parts[0] === "catalog" && parts[1] && parts[2] === "deployments" && method === "GET") return Response.json({ deployments: context.manager.store.listDeployments(owner, parts[1]) });
    if (parts[0] === "projects" && parts[1] && parts.length === 2 && method === "GET") {
      const project = context.manager.getProject(owner, parts[1]);
      return Response.json({ project, policy: context.manager.store.getPolicy(owner, project.id), deployments: context.manager.store.listDeployments(owner).filter((entry) => entry.projectId === project.id) });
    }
    if (parts[0] === "projects" && parts[1] && parts[2] === "policy" && method === "PUT") return Response.json({ policy: context.manager.putPolicy(owner, parts[1], await body(request)) });
    if (parts[0] === "projects" && parts[1] === "register" && method === "POST") {
      const input = await body(request);
      return Response.json({ project: await context.manager.registerProject(owner, String(input.directoryPath ?? ""), typeof input.name === "string" ? input.name : undefined, workspace.allowedDirectories) }, { status: 201 });
    }
    if (parts[0] === "deployments" && parts[1] === "plan" && method === "POST") {
      const input = await body(request);
      return Response.json(await context.manager.plan(owner, { action: String(input.action ?? "apply") as "apply", projectIds: strings(input.projectIds), skillIds: strings(input.skillIds), revisionId: typeof input.revisionId === "string" ? input.revisionId : undefined, deploymentName: typeof input.deploymentName === "string" ? input.deploymentName : undefined, resolution: typeof input.resolution === "string" ? input.resolution as "safe" : undefined }, workspace.allowedDirectories));
    }
    if (parts[0] === "deployments" && parts[1] === "apply" && method === "POST") return Response.json(await context.manager.apply(owner, String((await body(request)).planToken ?? "")));
    if (parts[0] === "deployments" && ["update", "remove", "detach"].includes(parts[1] ?? "") && method === "POST") return Response.json(await context.manager.apply(owner, String((await body(request)).planToken ?? "")));
    if (parts[0] === "deployments" && parts[1] === "reconcile" && method === "POST") return Response.json(await context.manager.reconcileState(owner));
    return Response.json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /not found/i.test(message) ? 404 : /outside|owner|authorized|Authentication|required administrator/i.test(message) ? 403 : /already exists|unsafe|stale|modified|unmanaged/i.test(message) ? 409 : 400;
    return Response.json({ error: message }, { status });
  }
}

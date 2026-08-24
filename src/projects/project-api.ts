import { statSync } from "node:fs";
import { homedir } from "node:os";
import { normalize, resolve, sep } from "node:path";

import type { RequestAuthContext } from "../auth/request-context";
import { normaliseNpub } from "../identity/npub-utils";
import type { ProjectStore, ProjectWithApps } from "./project-store";
import type { AppRecord } from "../apps/app-registry";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ProjectApiDependencies {
  store: ProjectStore;
  getAppById: (id: string) => Promise<AppRecord | undefined>;
}

export interface ProjectApiHandlerOptions {
  isAdmin?: boolean;
}

const parseRequestBody = async (request: Request): Promise<Record<string, unknown>> => {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch (error) {
    throw new Error(`Invalid JSON payload: ${(error as Error).message}`);
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid JSON payload");
  }
  return payload as Record<string, unknown>;
};

const expandUserPath = (value: unknown, label: string): string => {
  if (typeof value !== "string") {
    throw new Error(`${label} is required`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  const expanded = trimmed.startsWith("~/") ? resolve(homedir(), trimmed.slice(2)) : trimmed;
  return normalize(resolve(expanded));
};

const ensureDirectoryExists = (pathValue: string, label: string): void => {
  try {
    const stats = statSync(pathValue);
    if (!stats.isDirectory()) {
      throw new Error(`${label} must be a directory`);
    }
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code === "ENOENT") {
      throw new Error(`${label} does not exist`);
    }
    if (error instanceof Error) {
      throw new Error(`Unable to access ${label}: ${error.message}`);
    }
    throw new Error(`Unable to access ${label}`);
  }
};

const ensurePathWithinRoot = (root: string, candidate: string): void => {
  const normalisedRoot = normalize(root);
  const rootPrefix = normalisedRoot.endsWith(sep) ? normalisedRoot : `${normalisedRoot}${sep}`;
  const normalisedCandidate = normalize(candidate);
  if (normalisedCandidate !== normalisedRoot && !normalisedCandidate.startsWith(rootPrefix)) {
    throw new Error("App folder must live inside the project root");
  }
};

const serializeProject = (project: ProjectWithApps) => ({
  id: project.id,
  name: project.name,
  rootPath: project.rootPath,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
  apps: project.apps.map((app) => ({
    id: app.id,
    projectId: app.projectId,
    name: app.name,
    folderPath: app.folderPath,
    appId: app.appId,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
  })),
});

export const createProjectApiHandler = (dependencies: ProjectApiDependencies) => {
  const deps = dependencies;

  const handleCollection = async (method: HttpMethod, request: Request): Promise<Response> => {
    if (method === "GET") {
      const projects = deps.store.listProjects().map(serializeProject);
      return Response.json({ projects });
    }

    if (method === "POST") {
      let body: Record<string, unknown>;
      try {
        body = await parseRequestBody(request);
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }

      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) {
        return Response.json({ error: "Project name is required" }, { status: 400 });
      }

      let rootPath: string;
      try {
        rootPath = expandUserPath(body.rootPath, "Project folder");
        ensureDirectoryExists(rootPath, "Project folder");
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }

      try {
        const created = deps.store.createProject({ name, rootPath });
        return Response.json({ project: serializeProject(created) }, { status: 201 });
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
    }

    return Response.json({ error: "Method not allowed" }, { status: 405 });
  };

  const handleProjectApps = async (
    method: HttpMethod,
    projectId: string,
    request: Request,
    authContext: RequestAuthContext,
    options: ProjectApiHandlerOptions,
  ): Promise<Response> => {
    if (method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const project = deps.store.getProject(projectId);
    if (!project) {
      return Response.json({ error: "Project not found" }, { status: 404 });
    }

    let body: Record<string, unknown>;
    try {
      body = await parseRequestBody(request);
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }

    const nameInput = typeof body.name === "string" ? body.name.trim() : "";
    const folderInput = body.folderPath;
    const appIdInput = typeof body.appId === "string" ? body.appId.trim() : "";

    let resolvedName = nameInput;
    let resolvedFolderPath: string | null = null;
    let resolvedAppId: string | null = null;

    const viewerNpub = normaliseNpub(authContext.npub ?? null);
    const isAdmin = Boolean(options?.isAdmin);

    if (appIdInput) {
      const existing = await deps.getAppById(appIdInput);
      if (!existing) {
        return Response.json({ error: "App not found" }, { status: 404 });
      }
      if (!isAdmin) {
        if (!viewerNpub) {
          return Response.json({ error: "Unable to resolve app owner" }, { status: 403 });
        }
        const owner = normaliseNpub(existing.ownerNpub ?? null);
        if (!owner || owner !== viewerNpub) {
          return Response.json({ error: "App is not accessible" }, { status: 403 });
        }
      }
      resolvedAppId = existing.id;
      resolvedName = resolvedName || existing.label || "App";
      resolvedFolderPath = existing.root;
    }

    if (!resolvedAppId) {
      if (!resolvedName) {
        return Response.json({ error: "App name is required" }, { status: 400 });
      }
      try {
        resolvedFolderPath = expandUserPath(folderInput, "App folder");
        ensureDirectoryExists(resolvedFolderPath, "App folder");
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
    }

    if (!resolvedFolderPath) {
      return Response.json({ error: "App folder is required" }, { status: 400 });
    }

    try {
      ensurePathWithinRoot(project.rootPath, resolvedFolderPath);
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }

    if (resolvedAppId) {
      const existingLinks = deps.store.listAppsForProject(projectId);
      if (existingLinks.some((entry) => entry.appId === resolvedAppId)) {
        return Response.json({ error: "App already linked to this project" }, { status: 409 });
      }
    }

    try {
      deps.store.addProjectApp({
        projectId,
        name: resolvedName,
        folderPath: resolvedFolderPath,
        appId: resolvedAppId,
      });
      const updated = deps.store.getProjectWithApps(projectId);
      if (!updated) {
        return Response.json({ error: "Unable to load project" }, { status: 500 });
      }
      return Response.json({ project: serializeProject(updated) }, { status: 201 });
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }
  };

  return async (
    request: Request,
    url: URL,
    method: HttpMethod,
    authContext: RequestAuthContext,
    options: ProjectApiHandlerOptions = {},
  ): Promise<Response | null> => {
    if (!url.pathname.startsWith("/api/projects")) {
      return null;
    }

    if (!authContext.session) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }

    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length === 2) {
      return handleCollection(method, request);
    }
    if (segments.length === 4 && segments[2] && segments[3] === "apps") {
      const projectId = decodeURIComponent(segments[2]);
      return handleProjectApps(method, projectId, request, authContext, options);
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  };
};

import { existsSync, statSync } from "node:fs";
import { resolve, normalize } from "node:path";
import { homedir } from "node:os";

import type { RequestAuthContext } from "../auth/request-context";
import { normaliseNpub } from "../identity/npub-utils";
import { npubProjectStore, type NpubProjectRecord } from "./npub-project-store";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const serializeProject = (project: NpubProjectRecord) => ({
  id: project.id,
  npub: project.npub,
  directoryPath: project.directoryPath,
  name: project.name,
  isCustomName: project.isCustomName,
  worktreeName: project.worktreeName,
  appId: project.appId,
  taskBoardUrl: project.taskBoardUrl,
  lastUsedAt: project.lastUsedAt,
  sessionCount: project.sessionCount,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
});

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

const expandPath = (pathStr: string): string => {
  if (pathStr.startsWith("~/")) {
    return resolve(homedir(), pathStr.slice(2));
  }
  return resolve(normalize(pathStr));
};

const validateDirectory = (pathStr: string): { valid: boolean; error?: string; resolvedPath?: string } => {
  const resolved = expandPath(pathStr);
  if (!existsSync(resolved)) {
    return { valid: false, error: "Directory does not exist" };
  }
  try {
    const stats = statSync(resolved);
    if (!stats.isDirectory()) {
      return { valid: false, error: "Path is not a directory" };
    }
  } catch {
    return { valid: false, error: "Cannot access directory" };
  }
  return { valid: true, resolvedPath: resolved };
};

type NpubProjectStoreApi = Pick<typeof npubProjectStore,
  "listByNpub" | "createProject" | "getById" | "updateName" | "resetName" | "updateTaskBoardUrl" | "delete"
>;

export const createNpubProjectApiHandler = (store: NpubProjectStoreApi = npubProjectStore) => {
  const handleCollection = async (
    method: HttpMethod,
    url: URL,
    request: Request,
    authContext: RequestAuthContext,
    isAdmin: boolean,
  ): Promise<Response> => {
    if (method === "GET") {
      // Allow admin to query any npub, otherwise use the authenticated user's npub
      const queryNpub = url.searchParams.get("npub");
      let targetNpub: string | null = null;

      if (isAdmin && queryNpub) {
        targetNpub = normaliseNpub(queryNpub);
      } else if (authContext.npub) {
        targetNpub = normaliseNpub(authContext.npub);
      }

      if (!targetNpub) {
        return Response.json({ error: "No valid npub specified" }, { status: 400 });
      }

      const projects = store.listByNpub(targetNpub).map(serializeProject);
      return Response.json({ projects });
    }

    if (method === "POST") {
      const userNpub = normaliseNpub(authContext.npub ?? null);
      if (!userNpub) {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }

      let body: Record<string, unknown>;
      try {
        body = await parseRequestBody(request);
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }

      const directoryPath = typeof body.directoryPath === "string" ? body.directoryPath.trim() : "";
      if (!directoryPath) {
        return Response.json({ error: "directoryPath is required" }, { status: 400 });
      }

      const validation = validateDirectory(directoryPath);
      if (!validation.valid) {
        return Response.json({ error: validation.error }, { status: 400 });
      }

      const customName = typeof body.name === "string" ? body.name.trim() : undefined;

      try {
        const project = store.createProject(userNpub, validation.resolvedPath!, customName);
        if (!project) {
          return Response.json({ error: "Project already exists for this directory" }, { status: 409 });
        }
        return Response.json({ project: serializeProject(project) }, { status: 201 });
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 500 });
      }
    }

    return Response.json({ error: "Method not allowed" }, { status: 405 });
  };

  const handleSingleProject = async (
    method: HttpMethod,
    projectId: string,
    request: Request,
    authContext: RequestAuthContext,
    isAdmin: boolean,
  ): Promise<Response> => {
    const project = store.getById(projectId);
    if (!project) {
      return Response.json({ error: "Project not found" }, { status: 404 });
    }

    // Check ownership unless admin
    const viewerNpub = normaliseNpub(authContext.npub ?? null);
    if (!isAdmin && (!viewerNpub || viewerNpub !== project.npub)) {
      return Response.json({ error: "Not authorized" }, { status: 403 });
    }

    if (method === "GET") {
      return Response.json({ project: serializeProject(project) });
    }

    if (method === "PATCH") {
      let body: Record<string, unknown>;
      try {
        body = await parseRequestBody(request);
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }

      // Handle name update
      if ("name" in body) {
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name) {
          return Response.json({ error: "Project name cannot be empty" }, { status: 400 });
        }
        const updated = store.updateName(projectId, name);
        if (!updated) {
          return Response.json({ error: "Failed to update project" }, { status: 500 });
        }
        return Response.json({ project: serializeProject(updated) });
      }

      // Handle reset name
      if (body.resetName === true) {
        const updated = store.resetName(projectId);
        if (!updated) {
          return Response.json({ error: "Failed to reset project name" }, { status: 500 });
        }
        return Response.json({ project: serializeProject(updated) });
      }

      // Handle task board URL update
      if ("taskBoardUrl" in body) {
        const url = typeof body.taskBoardUrl === "string" ? body.taskBoardUrl.trim() : null;
        const updated = store.updateTaskBoardUrl(projectId, url || null);
        if (!updated) {
          return Response.json({ error: "Failed to update task board URL" }, { status: 500 });
        }
        return Response.json({ project: serializeProject(updated) });
      }

      return Response.json({ error: "No valid update fields provided" }, { status: 400 });
    }

    if (method === "DELETE") {
      const deleted = store.delete(projectId);
      if (!deleted) {
        return Response.json({ error: "Failed to delete project" }, { status: 500 });
      }
      return Response.json({ success: true });
    }

    return Response.json({ error: "Method not allowed" }, { status: 405 });
  };

  return async (
    request: Request,
    url: URL,
    method: HttpMethod,
    authContext: RequestAuthContext,
    isAdmin: boolean = false,
  ): Promise<Response | null> => {
    if (!url.pathname.startsWith("/api/npub-projects")) {
      return null;
    }

    // Auth is handled by the server route guard (supports both session and NIP-98)
    if (!authContext.session && !authContext.npub) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }

    const segments = url.pathname.split("/").filter(Boolean);

    // /api/npub-projects
    if (segments.length === 2) {
      return handleCollection(method, url, request, authContext, isAdmin);
    }

    // /api/npub-projects/:id
    if (segments.length === 3 && segments[2]) {
      const projectId = decodeURIComponent(segments[2]);
      return handleSingleProject(method, projectId, request, authContext, isAdmin);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  };
};

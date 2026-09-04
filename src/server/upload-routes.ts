/**
 * Route handlers for file upload endpoints and upload serving.
 * Extracted from server.ts to reduce file size.
 *
 * Covers:
 *  - POST /api/uploads/images
 *  - GET  /api/uploads/images/status
 *  - POST /api/uploads/files
 *  - GET  /uploads/images/:segment/...  (static serving outside handleApi)
 *  - GET  /uploads/files/:segment/...   (static serving outside handleApi)
 */

import { writeFile } from "node:fs/promises";
import { join, normalize, sep } from "node:path";

import type { AgentType } from "../config";
import type { RequestAuthContext } from "../auth/request-context";
import type { AccessAction } from "../auth/access-control";
import { deriveNpubSegment } from "../identity/npub-utils";
import { secureResolvePath, validatePathSegment, sanitizePath } from "./path-security.js";

// ---------- Size limits ----------

export const maxImageSizeBytes = 10 * 1024 * 1024; // 10MB
export const maxAttachmentSizeBytes = 25 * 1024 * 1024; // 25MB

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

// ---------- Context supplied by server.ts ----------

export interface UploadApiContext {
  imageRoot: string;
  attachmentRoot: string;
  isAdminContext: (authContext: RequestAuthContext) => boolean;
  isAgentType: (value: string) => value is AgentType;
  ensureImageDirectory: (agent: AgentType, npub: string | null) => Promise<string>;
  ensureAttachmentDirectory: (agent: AgentType, npub: string | null) => Promise<string>;
  createImageFilename: (name: string, mime: string, uploadId?: string) => string;
  createAttachmentFilename: (name: string, mime: string) => string;
  buildAgentImagePlaceholder: (agent: AgentType, absolutePath: string, publicPath: string) => string;
  buildAgentFilePlaceholder: (
    agent: AgentType,
    absolutePath: string,
    publicPath: string,
    originalName: string | undefined,
  ) => string;
  ensureApiAccess: (
    action: AccessAction,
    request: Request,
    url: URL,
    authContext: RequestAuthContext,
  ) => Promise<Response | null>;
  AccessActions: { FilesWrite: AccessAction };
}

// ---------- Internal helper ----------

/**
 * Resolves a scoped upload path with security checks. Returns the BunFile and
 * its resolved absolute path, or undefined if access should be denied.
 */
function resolveScopedUpload(
  pathname: string,
  authContext: RequestAuthContext,
  prefix: string,
  root: string,
  isAdminContext: (authContext: RequestAuthContext) => boolean,
): { file: ReturnType<typeof Bun.file>; fullPath: string } | undefined {
  if (!pathname.startsWith(prefix)) return undefined;
  const relative = pathname.slice(prefix.length);
  if (!relative) return undefined;
  if (!authContext.session) return undefined;

  const parts = relative.split("/").filter((segment) => segment.length > 0);
  if (parts.length < 2) return undefined;

  const segment = parts[0];
  const rest = parts.slice(1);

  if (!segment || !validatePathSegment(segment)) {
    return undefined;
  }

  for (const part of rest) {
    if (!validatePathSegment(part)) {
      return undefined;
    }
  }

  const expectedSegment = deriveNpubSegment(authContext.npub ?? null);
  if (!isAdminContext(authContext) && segment !== expectedSegment) {
    return undefined;
  }

  try {
    const userRoot = secureResolvePath(root, segment);
    const relativePath = rest.join(sep);
    const sanitizedRelative = sanitizePath(relativePath);
    const fullPath = secureResolvePath(userRoot, sanitizedRelative);

    const file = Bun.file(fullPath);
    if (file.size === 0) return undefined;

    return { file, fullPath };
  } catch (error) {
    console.warn("[security] Path traversal attempt in upload:", error);
    return undefined;
  }
}

const imageUploadIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function buildImageUploadPayload(
  agent: AgentType,
  originalName: string,
  filename: string,
  diskPath: string,
  imageSegment: string,
  ctx: UploadApiContext,
) {
  const relativePath = normalize(join(imageSegment, agent, filename)).replace(/\\/g, "/");
  const publicPath = `/uploads/images/${relativePath}`;
  return {
    agent,
    name: originalName,
    publicPath,
    relativePath,
    placeholder: ctx.buildAgentImagePlaceholder(agent, diskPath, publicPath),
  };
}

// ---------- Static serving (called outside handleApi) ----------

/**
 * Attempts to serve a GET request for a user-scoped uploaded image.
 * Returns undefined if the path does not match or access is denied.
 */
export function resolveTempImage(
  pathname: string,
  authContext: RequestAuthContext,
  ctx: Pick<UploadApiContext, "imageRoot" | "isAdminContext">,
): Response | undefined {
  const resolved = resolveScopedUpload(
    pathname,
    authContext,
    "/uploads/images/",
    ctx.imageRoot,
    ctx.isAdminContext,
  );
  if (!resolved) return undefined;
  const { file } = resolved;
  return new Response(file, {
    headers: {
      ...(file.type ? { "content-type": file.type } : {}),
      "cache-control": "no-store",
    },
  });
}

/**
 * Attempts to serve a GET request for a user-scoped uploaded attachment.
 * Returns undefined if the path does not match or access is denied.
 */
export function resolveTempAttachment(
  pathname: string,
  authContext: RequestAuthContext,
  ctx: Pick<UploadApiContext, "attachmentRoot" | "isAdminContext">,
): Response | undefined {
  const resolved = resolveScopedUpload(
    pathname,
    authContext,
    "/uploads/files/",
    ctx.attachmentRoot,
    ctx.isAdminContext,
  );
  if (!resolved) return undefined;
  const { file } = resolved;
  return new Response(file, {
    headers: {
      ...(file.type ? { "content-type": file.type } : {}),
      "cache-control": "no-store",
    },
  });
}

// ---------- API route handlers ----------

/**
 * Handles POST /api/uploads/images and POST /api/uploads/files.
 * Returns null if neither route matches.
 */
export async function handleUploadsApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: UploadApiContext,
): Promise<Response | null> {
  const pathname = url.pathname;

  // GET /api/uploads/images/status — recover a completed upload whose POST response was lost
  if (pathname === "/api/uploads/images/status" && method === "GET") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.FilesWrite, request, url, authContext);
    if (denied) {
      return denied;
    }

    const agentInput = url.searchParams.get("agent")?.toLowerCase() ?? "";
    if (!ctx.isAgentType(agentInput)) {
      return Response.json({ error: "Unsupported agent target" }, { status: 400 });
    }

    const uploadId = url.searchParams.get("uploadId") ?? "";
    const originalName = url.searchParams.get("name") ?? "";
    const mime = url.searchParams.get("mime") ?? "";
    if (!imageUploadIdPattern.test(uploadId) || !originalName || !mime.startsWith("image/")) {
      return Response.json({ error: "Invalid image upload reference" }, { status: 400 });
    }

    const userNpub = authContext.npub ?? null;
    const imageSegment = deriveNpubSegment(userNpub);
    let directory: string;
    try {
      directory = await ctx.ensureImageDirectory(agentInput, userNpub);
    } catch (error) {
      console.error("[uploads] failed to inspect image storage", error);
      return Response.json({ error: "Failed to inspect image storage" }, { status: 500 });
    }
    const filename = ctx.createImageFilename(originalName, mime, uploadId);
    const diskPath = join(directory, filename);
    if (Bun.file(diskPath).size === 0) {
      return Response.json({ error: "Image upload not found" }, { status: 404 });
    }

    return Response.json(buildImageUploadPayload(
      agentInput,
      originalName,
      filename,
      diskPath,
      imageSegment,
      ctx,
    ));
  }

  // POST /api/uploads/images — image upload with formdata
  if (pathname === "/api/uploads/images" && method === "POST") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.FilesWrite, request, url, authContext);
    if (denied) {
      return denied;
    }

    let form: Awaited<ReturnType<Request["formData"]>>;
    try {
      // Read body as blob first to work around cloudflared streaming issues
      const contentType = request.headers.get("content-type") ?? "";
      const bodyBlob = await request.blob();
      const bufferedRequest = new Request(request.url, {
        method: request.method,
        headers: { "content-type": contentType },
        body: bodyBlob,
      });
      form = await bufferedRequest.formData();
    } catch {
      return Response.json({ error: "Invalid form data" }, { status: 400 });
    }

    const agentInput = form.get("agent");
    const agent = typeof agentInput === "string" ? agentInput.toLowerCase() : "";
    if (!ctx.isAgentType(agent)) {
      return Response.json({ error: "Unsupported agent target" }, { status: 400 });
    }

    const fileEntry = form.get("image");
    if (!fileEntry || typeof (fileEntry as Blob).arrayBuffer !== "function") {
      return Response.json({ error: "Image file is required" }, { status: 400 });
    }

    const file = fileEntry as Blob & { name?: string; size: number; type?: string };

    const uploadIdEntry = form.get("uploadId");
    const uploadId = typeof uploadIdEntry === "string" && uploadIdEntry.length > 0
      ? uploadIdEntry
      : undefined;
    if (uploadId && !imageUploadIdPattern.test(uploadId)) {
      return Response.json({ error: "Invalid image upload ID" }, { status: 400 });
    }

    if (file.size === 0) {
      return Response.json({ error: "Empty files are not allowed" }, { status: 400 });
    }

    if (file.size > maxImageSizeBytes) {
      return Response.json({ error: "Image exceeds 10MB limit" }, { status: 413 });
    }

    if (!file.type?.startsWith("image/")) {
      return Response.json({ error: "Only image uploads are supported" }, { status: 400 });
    }

    const userNpub = authContext.npub ?? null;
    const imageSegment = deriveNpubSegment(userNpub);
    let directory: string;
    try {
      directory = await ctx.ensureImageDirectory(agent, userNpub);
    } catch (error) {
      console.error("[uploads] failed to ensure directory", error);
      return Response.json({ error: "Failed to prepare image storage" }, { status: 500 });
    }

    const originalName = file.name ?? "upload";
    const filename = ctx.createImageFilename(originalName, file.type ?? "", uploadId);
    const diskPath = join(directory, filename);
    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      await writeFile(diskPath, buffer);
    } catch (error) {
      console.error("[uploads] failed to persist image", error);
      return Response.json({ error: "Failed to store image" }, { status: 500 });
    }

    return Response.json(buildImageUploadPayload(
      agent,
      originalName,
      filename,
      diskPath,
      imageSegment,
      ctx,
    ));
  }

  // POST /api/uploads/files — multi-file upload with formdata
  if (pathname === "/api/uploads/files" && method === "POST") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.FilesWrite, request, url, authContext);
    if (denied) {
      return denied;
    }

    let form: Awaited<ReturnType<Request["formData"]>>;
    try {
      form = await request.formData();
    } catch {
      return Response.json({ error: "Invalid form data" }, { status: 400 });
    }

    const agentInput = form.get("agent");
    const agent = typeof agentInput === "string" ? agentInput.toLowerCase() : "";
    if (!ctx.isAgentType(agent)) {
      return Response.json({ error: "Unsupported agent target" }, { status: 400 });
    }

    const fileEntries = form.getAll("file").filter((entry) => entry && typeof (entry as Blob).arrayBuffer === "function");
    if (fileEntries.length === 0) {
      return Response.json({ error: "File upload payload is required" }, { status: 400 });
    }

    const userNpub = authContext.npub ?? null;
    const attachmentSegment = deriveNpubSegment(userNpub);
    let directory: string;
    try {
      directory = await ctx.ensureAttachmentDirectory(agent, userNpub);
    } catch (error) {
      console.error("[uploads] failed to ensure attachment directory", error);
      return Response.json({ error: "Failed to prepare file storage" }, { status: 500 });
    }

    const results = [];
    for (const entry of fileEntries) {
      const file = entry as Blob & { name?: string; size: number; type?: string };
      if (file.size === 0) {
        return Response.json({ error: "Empty files are not allowed" }, { status: 400 });
      }
      if (file.size > maxAttachmentSizeBytes) {
        return Response.json({ error: "File exceeds 25MB limit" }, { status: 413 });
      }

      const filename = ctx.createAttachmentFilename(file.name ?? "upload", file.type ?? "");
      const diskPath = join(directory, filename);
      try {
        const buffer = Buffer.from(await file.arrayBuffer());
        await writeFile(diskPath, buffer);
      } catch (error) {
        console.error("[uploads] failed to persist attachment", error);
        return Response.json({ error: "Failed to store file" }, { status: 500 });
      }

      const relativePath = normalize(join(attachmentSegment, agent, filename)).replace(/\\/g, "/");
      const publicPath = `/uploads/files/${relativePath}`;
      const placeholder = ctx.buildAgentFilePlaceholder(agent, diskPath, publicPath, file.name);
      results.push({
        agent,
        name: file.name ?? filename,
        size: file.size,
        mime: file.type ?? null,
        publicPath,
        relativePath,
        absolutePath: diskPath,
        placeholder,
      });
    }

    return Response.json({ files: results }, { status: 201 });
  }

  return null;
}

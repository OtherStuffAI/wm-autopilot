/**
 * API route handlers for docs/files endpoints.
 * Extracted from server.ts to reduce file size.
 */

import {
  normalize,
  join,
  relative,
  extname,
  basename,
  dirname,
  sep,
} from "node:path";
import { constants } from "node:fs";
import { Readable } from "node:stream";
import {
  stat,
  readdir,
  mkdir,
  rm,
  rename,
} from "node:fs/promises";
import { z } from "zod";
import { validateInput, JsonRequestSchema } from "../utils/validation";
import type { WorkspaceScope } from "../workspaces/workspace-scope";
import type { RequestAuthContext } from "../auth/request-context";
import type { AccessAction } from "../auth/access-control";
import { authorizeFilesystemPath, openAuthorizedFile } from "../security/filesystem-boundary";

// ---------- Types ----------

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

type GitCommandAction = "init" | "addAll" | "commit" | "push" | "pushUpstream" | "pull";


interface DocsPreviewType {
  format: "markdown" | "code" | "image" | "json" | "csv" | "pdf";
  language: string;
  label: string;
  mimeType?: string;
}

interface CreateDocsFilePayload {
  content?: unknown;
  base64?: unknown;
}

// ---------- Context supplied by server.ts ----------

export interface DocsApiContext {
  resolveWorkspace: (context?: RequestAuthContext) => WorkspaceScope;
  ensureApiAccess: (
    action: AccessAction,
    request: Request,
    url: URL,
    authContext: RequestAuthContext,
  ) => Promise<Response | null>;
  AccessActions: { FilesRead: AccessAction; FilesWrite: AccessAction };
  ensureDirectory: (
    input: string | null | undefined,
    scope?: WorkspaceScope,
  ) => Promise<string>;
  createGitWorktree: (options: {
    directory: string;
    branch: string;
    startPoint: string | null;
  }) => Promise<{ branch: string; path: string; repository: unknown }>;
  executeGitCommand: (options: {
    directory: string;
    action: GitCommandAction;
    message?: string | null;
    remote?: string | null;
    remoteUrl?: string | null;
    branch?: string | null;
    viewerNpub?: string | null;
    expectedRemoteHost?: string | null;
  }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  describeGitRepository: (directory: string) => Promise<Record<string, unknown> | null>;
}

// ---------- Private helpers ----------

function normaliseOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const FILE_NAME_MAX_LENGTH = 200;
const MAX_DOCS_ENTRIES = 500;
const MAX_DOCS_FILE_SIZE = 2 * 1024 * 1024; // 2MB
const DOCS_NAME_MAX_LENGTH = 160;
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const DOCS_DISPLAY_ROOT = "Workspace";

function normaliseDocsFileName(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("File name is required");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("File name is required");
  }
  if (trimmed.length > FILE_NAME_MAX_LENGTH) {
    throw new Error("File name is too long");
  }
  if (trimmed === "." || trimmed === "..") {
    throw new Error("File name is not allowed");
  }
  if (/[\\/]/.test(trimmed)) {
    throw new Error("File name cannot contain path separators");
  }
  return trimmed;
}

function normaliseDocsEntryName(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Name is required");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Name is required");
  }
  if (trimmed.length > DOCS_NAME_MAX_LENGTH) {
    throw new Error("Name is too long");
  }
  if (trimmed === "." || trimmed === "..") {
    throw new Error("Name is not allowed");
  }
  if (/[\\/]/.test(trimmed)) {
    throw new Error("Name cannot contain path separators");
  }
  return trimmed;
}

function isWithinDocsRoot(target: string, scope: WorkspaceScope): boolean {
  if (!target) return false;
  const normalized = normalize(target);
  return normalized === scope.docsRoot || normalized.startsWith(scope.docsRootBoundary);
}

function toDocsRelativePath(target: string, scope: WorkspaceScope): string {
  if (!target) return "";
  if (!isWithinDocsRoot(target, scope)) {
    return "";
  }
  const relativePath = relative(scope.docsRoot, target);
  return relativePath && relativePath.length > 0 ? relativePath : "";
}

function toDocsDisplayPath(target: string, scope: WorkspaceScope): string {
  const relativePath = toDocsRelativePath(target, scope);
  return relativePath ? `${DOCS_DISPLAY_ROOT}/${relativePath}` : DOCS_DISPLAY_ROOT;
}

async function resolveDocsPath(
  input: string | null | undefined,
  scope: WorkspaceScope,
  policy: "existing" | "create" = "existing",
): Promise<string> {
  const value = input?.trim();
  const candidate = value && value.length > 0 ? value : scope.docsRoot;
  return authorizeFilesystemPath({
    root: scope.docsRoot,
    input: candidate,
    policy,
    allowAbsoluteInput: true,
  });
}

const TEXT_PREVIEW_TYPES = new Map<string, DocsPreviewType>([
  [".md", { format: "markdown", language: "markdown", label: "Markdown" }],
  [".markdown", { format: "markdown", language: "markdown", label: "Markdown" }],
  [".mdx", { format: "markdown", language: "markdown", label: "Markdown" }],
  [".txt", { format: "code", language: "plaintext", label: "Text" }],
  [".log", { format: "code", language: "plaintext", label: "Log" }],
  [".json", { format: "json", language: "json", label: "JSON", mimeType: "application/json" }],
  [".jsonc", { format: "code", language: "json", label: "JSON" }],
  [".csv", { format: "csv", language: "csv", label: "CSV", mimeType: "text/csv" }],
  [".tsv", { format: "csv", language: "tsv", label: "TSV", mimeType: "text/tab-separated-values" }],
  [".pdf", { format: "pdf", language: "pdf", label: "PDF", mimeType: "application/pdf" }],
  [".yaml", { format: "code", language: "yaml", label: "YAML" }],
  [".yml", { format: "code", language: "yaml", label: "YAML" }],
  [".js", { format: "code", language: "javascript", label: "JavaScript" }],
  [".mjs", { format: "code", language: "javascript", label: "JavaScript" }],
  [".cjs", { format: "code", language: "javascript", label: "JavaScript" }],
  [".ts", { format: "code", language: "typescript", label: "TypeScript" }],
  [".tsx", { format: "code", language: "typescript", label: "TypeScript" }],
  [".jsx", { format: "code", language: "javascript", label: "JavaScript" }],
  [".go", { format: "code", language: "go", label: "Go" }],
  [".rs", { format: "code", language: "rust", label: "Rust" }],
  [".py", { format: "code", language: "python", label: "Python" }],
  [".sh", { format: "code", language: "shell", label: "Shell" }],
  [".bash", { format: "code", language: "shell", label: "Shell" }],
  [".zsh", { format: "code", language: "shell", label: "Shell" }],
  [".ini", { format: "code", language: "ini", label: "Config" }],
  [".conf", { format: "code", language: "ini", label: "Config" }],
  [".toml", { format: "code", language: "toml", label: "TOML" }],
  [".env", { format: "code", language: "ini", label: "Config" }],
  [".css", { format: "code", language: "css", label: "CSS" }],
  [".html", { format: "code", language: "html", label: "HTML" }],
]);

const TEXT_PREVIEW_TYPES_BY_NAME = new Map<string, DocsPreviewType>([
  [".env", { format: "code", language: "ini", label: "Config" }],
  [".env.example", { format: "code", language: "ini", label: "Config" }],
]);

const IMAGE_PREVIEW_TYPES = new Map<string, DocsPreviewType>([
  [".apng", { format: "image", language: "image", label: "Image", mimeType: "image/apng" }],
  [".avif", { format: "image", language: "image", label: "Image", mimeType: "image/avif" }],
  [".bmp", { format: "image", language: "image", label: "Image", mimeType: "image/bmp" }],
  [".gif", { format: "image", language: "image", label: "Image", mimeType: "image/gif" }],
  [".heic", { format: "image", language: "image", label: "Image", mimeType: "image/heic" }],
  [".heif", { format: "image", language: "image", label: "Image", mimeType: "image/heif" }],
  [".ico", { format: "image", language: "image", label: "Image", mimeType: "image/x-icon" }],
  [".jfif", { format: "image", language: "image", label: "Image", mimeType: "image/jpeg" }],
  [".jpe", { format: "image", language: "image", label: "Image", mimeType: "image/jpeg" }],
  [".jpeg", { format: "image", language: "image", label: "Image", mimeType: "image/jpeg" }],
  [".jpg", { format: "image", language: "image", label: "Image", mimeType: "image/jpeg" }],
  [".jxl", { format: "image", language: "image", label: "Image", mimeType: "image/jxl" }],
  [".pjp", { format: "image", language: "image", label: "Image", mimeType: "image/jpeg" }],
  [".pjpeg", { format: "image", language: "image", label: "Image", mimeType: "image/jpeg" }],
  [".png", { format: "image", language: "image", label: "Image", mimeType: "image/png" }],
  [".svg", { format: "image", language: "image", label: "Image", mimeType: "image/svg+xml" }],
  [".tif", { format: "image", language: "image", label: "Image", mimeType: "image/tiff" }],
  [".tiff", { format: "image", language: "image", label: "Image", mimeType: "image/tiff" }],
  [".webp", { format: "image", language: "image", label: "Image", mimeType: "image/webp" }],
]);

function resolveDocsMimeType(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  const imageType = IMAGE_PREVIEW_TYPES.get(extension)?.mimeType;
  if (imageType) return imageType;
  const textType = TEXT_PREVIEW_TYPES.get(extension)?.mimeType;
  if (textType) return textType;
  return Bun.file(filePath).type || "application/octet-stream";
}

function buildContentDisposition(fileName: string, mode: "attachment" | "inline"): string {
  return `${mode}; filename="${fileName.replace(/"/g, '\\"')}"`;
}

function resolveEntryPreviewType(filePath: string): DocsPreviewType | null {
  const name = basename(filePath).toLowerCase();
  const extension = extname(name).toLowerCase();
  const textPreview = TEXT_PREVIEW_TYPES_BY_NAME.get(name) ?? TEXT_PREVIEW_TYPES.get(extension);
  if (textPreview) return textPreview;

  const imagePreview = IMAGE_PREVIEW_TYPES.get(extension);
  if (imagePreview) return imagePreview;

  const mimeType = Bun.file(filePath).type;
  if (mimeType.startsWith("image/")) {
    return { format: "image", language: "image", label: "Image", mimeType };
  }

  return null;
}

function resolvePreviewType(filePath: string): DocsPreviewType {
  const preview = resolveEntryPreviewType(filePath);
  if (!preview) {
    throw new Error("Preview for this file type is not supported");
  }
  return preview;
}

async function ensureDocsDirectory(
  input: string | null | undefined,
  scope: WorkspaceScope,
): Promise<string> {
  const directory = await resolveDocsPath(input, scope);
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(directory);
  } catch {
    throw new Error("Parent directory not found");
  }
  if (!stats.isDirectory()) {
    throw new Error("Parent path is not a directory");
  }
  return directory;
}

async function listDocsDirectory(
  input: string | null | undefined,
  options: { includeHidden?: boolean } = {},
  scope: WorkspaceScope,
  describeGitRepository: (directory: string) => Promise<Record<string, unknown> | null>,
) {
  const directory = await resolveDocsPath(input, scope);
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(directory);
  } catch {
    throw new Error("Directory not found");
  }

  if (!stats.isDirectory()) {
    throw new Error("Requested path is not a directory");
  }

  const includeHidden = Boolean(options.includeHidden);

  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true }) as import("node:fs").Dirent[];
  } catch (error) {
    throw new Error(`Failed to read directory: ${(error as Error).message ?? "unknown error"}`);
  }

  const directories: Array<{
    name: string;
    path: string;
    relativePath: string;
    displayPath: string;
    type: "directory";
  }> = [];
  const files: Array<{
    name: string;
    path: string;
    relativePath: string;
    displayPath: string;
    type: "file";
    previewable: boolean;
    previewFormat: DocsPreviewType["format"] | null;
    previewLanguage: string | null;
    previewLabel: string | null;
  }> = [];

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }

    if (!includeHidden && entry.name.startsWith(".")) {
      continue;
    }

    const entryPath = normalize(join(directory, entry.name));
    if (!isWithinDocsRoot(entryPath, scope)) {
      continue;
    }

    if (entry.isDirectory()) {
      const relativePath = toDocsRelativePath(entryPath, scope);
      directories.push({
        name: entry.name,
        path: entryPath,
        relativePath,
        displayPath: toDocsDisplayPath(entryPath, scope),
        type: "directory",
      });
      continue;
    }

    if (entry.isFile()) {
      const relativePath = toDocsRelativePath(entryPath, scope);
      const preview = resolveEntryPreviewType(entryPath);
      files.push({
        name: entry.name,
        path: entryPath,
        relativePath,
        displayPath: toDocsDisplayPath(entryPath, scope),
        type: "file",
        previewable: preview !== null,
        previewFormat: preview?.format ?? null,
        previewLanguage: preview?.language ?? null,
        previewLabel: preview?.label ?? null,
      });
    }

    if (directories.length + files.length >= MAX_DOCS_ENTRIES) {
      break;
    }
  }

  directories.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  const parentPath = (() => {
    if (directory === scope.docsRoot) {
      return null;
    }
    const candidate = dirname(directory);
    if (!isWithinDocsRoot(candidate, scope)) {
      return null;
    }
    return candidate;
  })();

  let git: Record<string, unknown> | null = null;
  try {
    git = await describeGitRepository(directory);
  } catch {
    git = null;
  }

  return {
    path: directory,
    relativePath: toDocsRelativePath(directory, scope),
    displayPath: toDocsDisplayPath(directory, scope),
    parent: parentPath
      ? {
          path: parentPath,
          relativePath: toDocsRelativePath(parentPath, scope),
          displayPath: toDocsDisplayPath(parentPath, scope),
        }
      : null,
    entries: [...directories, ...files],
    git,
  };
}

async function loadDocsFile(input: string | null | undefined, scope: WorkspaceScope) {
  if (!input) {
    throw new Error("File path is required");
  }

  const filePath = await resolveDocsPath(input, scope);
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(filePath);
  } catch {
    throw new Error("File not found");
  }

  if (!stats.isFile()) {
    throw new Error("Requested path is not a file");
  }

  const preview = resolvePreviewType(filePath);

  if (preview.format === "markdown" && !MARKDOWN_EXTENSIONS.has(extname(filePath).toLowerCase())) {
    throw new Error("Unsupported Markdown extension");
  }

  if (preview.format === "image" || preview.format === "pdf") {
    return {
      path: filePath,
      relativePath: toDocsRelativePath(filePath, scope),
      displayPath: toDocsDisplayPath(filePath, scope),
      name: basename(filePath),
      content: null,
      format: preview.format,
      language: preview.language,
      label: preview.label,
      mimeType: preview.mimeType ?? resolveDocsMimeType(filePath),
      size: stats.size,
    };
  }

  if (stats.size > MAX_DOCS_FILE_SIZE) {
    throw new Error("File is too large to preview");
  }

  let content: string;
  try {
    const opened = await openAuthorizedFile({ root: scope.docsRoot, input: filePath, flags: constants.O_RDONLY });
    try {
      content = await opened.handle.readFile("utf-8");
    } finally {
      await opened.handle.close();
    }
  } catch (error) {
    throw new Error(`Failed to read file: ${(error as Error).message ?? "unknown error"}`);
  }

  return {
    path: filePath,
    relativePath: toDocsRelativePath(filePath, scope),
    displayPath: toDocsDisplayPath(filePath, scope),
    name: basename(filePath),
    content,
    format: preview.format,
    language: preview.language,
    label: preview.label,
  };
}

async function loadDocsFileRaw(input: string | null | undefined, scope: WorkspaceScope) {
  if (!input) {
    throw new Error("File path is required");
  }

  const filePath = await resolveDocsPath(input, scope);
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(filePath);
  } catch {
    throw new Error("File not found");
  }

  if (!stats.isFile()) {
    throw new Error("Requested path is not a file");
  }

  if (stats.size > MAX_DOCS_FILE_SIZE) {
    throw new Error("File is too large to load");
  }

  let data: Uint8Array;
  try {
    const opened = await openAuthorizedFile({ root: scope.docsRoot, input: filePath, flags: constants.O_RDONLY });
    try {
      data = await opened.handle.readFile();
    } finally {
      await opened.handle.close();
    }
  } catch (error) {
    throw new Error(`Failed to read file: ${(error as Error).message ?? "unknown error"}`);
  }

  const base64 = Buffer.from(data).toString("base64");

  return {
    path: filePath,
    relativePath: toDocsRelativePath(filePath, scope),
    displayPath: toDocsDisplayPath(filePath, scope),
    name: basename(filePath),
    base64,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

async function updateDocsFile(
  pathInput: string | null | undefined,
  base64Input: string | null | undefined,
  expectedMtime: number | null | undefined,
  scope: WorkspaceScope,
) {
  if (!pathInput) {
    throw new Error("File path is required");
  }

  const filePath = await resolveDocsPath(pathInput, scope);

  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(filePath);
  } catch {
    throw new Error("File not found");
  }

  if (!stats.isFile()) {
    throw new Error("Requested path is not a file");
  }

  if (typeof expectedMtime === "number" && Math.abs(stats.mtimeMs - expectedMtime) > 1) {
    throw new Error("File has changed since it was loaded");
  }

  if (base64Input === null || base64Input === undefined) {
    throw new Error("File contents are required");
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64Input, "base64");
  } catch {
    throw new Error("Invalid base64 payload");
  }

  if (bytes.length > MAX_DOCS_FILE_SIZE) {
    throw new Error("File is too large to save");
  }

  try {
    const opened = await openAuthorizedFile({ root: scope.docsRoot, input: filePath, flags: constants.O_RDWR });
    try {
      await opened.handle.truncate(0);
      await opened.handle.writeFile(bytes);
      await opened.handle.sync();
    } finally {
      await opened.handle.close();
    }
  } catch (error) {
    throw new Error(`Failed to write file: ${(error as Error).message ?? "unknown error"}`);
  }

  const nextStats = await stat(filePath);

  return {
    path: filePath,
    relativePath: toDocsRelativePath(filePath, scope),
    displayPath: toDocsDisplayPath(filePath, scope),
    name: basename(filePath),
    size: nextStats.size,
    mtimeMs: nextStats.mtimeMs,
  };
}

async function createDocsDirectory(
  parentInput: string | null | undefined,
  nameInput: unknown,
  scope: WorkspaceScope,
) {
  const parentDirectory = await ensureDocsDirectory(parentInput, scope);
  const name = normaliseDocsEntryName(nameInput);
  const target = normalize(join(parentDirectory, name));
  if (!isWithinDocsRoot(target, scope)) {
    throw new Error("Invalid directory path");
  }

  try {
    const authorizedTarget = await resolveDocsPath(target, scope, "create");
    await mkdir(authorizedTarget, { recursive: false });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") {
      throw new Error("A file or directory with that name already exists");
    }
    throw new Error(`Failed to create directory: ${(error as Error).message ?? "unknown error"}`);
  }

  return {
    path: target,
    relativePath: toDocsRelativePath(target, scope),
    displayPath: toDocsDisplayPath(target, scope),
    name,
  };
}

async function createDocsFile(
  parentInput: string | null | undefined,
  nameInput: unknown,
  payloadInput: unknown,
  scope: WorkspaceScope,
) {
  const parentDirectory = await ensureDocsDirectory(parentInput, scope);
  const name = normaliseDocsEntryName(nameInput);
  const target = normalize(join(parentDirectory, name));
  if (!isWithinDocsRoot(target, scope)) {
    throw new Error("Invalid file path");
  }

  const payload =
    payloadInput && typeof payloadInput === "object" && !Array.isArray(payloadInput)
      ? (payloadInput as CreateDocsFilePayload)
      : null;

  let buffer: Buffer;
  if (payload && Object.prototype.hasOwnProperty.call(payload, "base64") && payload.base64 !== undefined) {
    const base64Value = payload.base64;
    if (base64Value !== null && base64Value !== undefined) {
      if (typeof base64Value !== "string") {
        throw new Error("Invalid base64 payload");
      }
      try {
        buffer = Buffer.from(base64Value, "base64");
      } catch {
        throw new Error("Invalid base64 payload");
      }
    } else {
      buffer = Buffer.from("", "utf-8");
    }
  } else {
    const contentValue = payload ? payload.content : payloadInput;
    const content =
      typeof contentValue === "string"
        ? contentValue
        : typeof contentValue === "number"
          ? contentValue.toString()
          : "";
    buffer = Buffer.from(content, "utf-8");
  }

  if (buffer.length > MAX_DOCS_FILE_SIZE) {
    throw new Error("File is too large to create");
  }

  try {
    const opened = await openAuthorizedFile({
      root: scope.docsRoot,
      input: target,
      flags: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      policy: "create",
      mode: 0o600,
    });
    try {
      await opened.handle.writeFile(buffer);
      await opened.handle.sync();
    } finally {
      await opened.handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") {
      throw new Error("A file or directory with that name already exists");
    }
    throw new Error(`Failed to create file: ${(error as Error).message ?? "unknown error"}`);
  }

  const preview = resolveEntryPreviewType(target);

  return {
    path: target,
    relativePath: toDocsRelativePath(target, scope),
    displayPath: toDocsDisplayPath(target, scope),
    name,
    previewable: preview !== null,
    previewFormat: preview?.format ?? null,
    previewLanguage: preview?.language ?? null,
    previewLabel: preview?.label ?? null,
  };
}

async function deleteDocsFile(pathInput: string | null | undefined, scope: WorkspaceScope) {
  const candidate = pathInput?.trim();
  if (!candidate) {
    throw new Error("File path is required");
  }
  const filePath = await resolveDocsPath(candidate, scope);

  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(filePath);
  } catch {
    throw new Error("File not found");
  }

  if (!stats.isFile()) {
    throw new Error("Requested path is not a file");
  }

  try {
    const reauthorizedPath = await resolveDocsPath(filePath, scope);
    await rm(reauthorizedPath, { force: false });
  } catch (error) {
    throw new Error(`Failed to delete file: ${(error as Error).message ?? "unknown error"}`);
  }

  return {
    path: filePath,
    relativePath: toDocsRelativePath(filePath, scope),
    displayPath: toDocsDisplayPath(filePath, scope),
    name: basename(filePath),
  };
}

async function copyDocsFile(
  pathInput: string | null | undefined,
  targetDirectoryInput: string | null | undefined,
  newNameInput: string | null | undefined,
  scope: WorkspaceScope,
) {
  const sourcePath = await resolveDocsPath(pathInput, scope);
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(sourcePath);
  } catch {
    throw new Error("File not found");
  }

  if (!stats.isFile()) {
    throw new Error("Requested path is not a file");
  }

  const targetDirectory = await ensureDocsDirectory(targetDirectoryInput, scope);
  const destinationName = newNameInput && newNameInput.trim().length > 0
    ? normaliseDocsFileName(newNameInput)
    : basename(sourcePath);
  const destinationPath = normalize(join(targetDirectory, destinationName));

  if (!isWithinDocsRoot(destinationPath, scope)) {
    throw new Error("Invalid destination path");
  }

  if (destinationPath === sourcePath) {
    throw new Error("Destination matches the source file");
  }

  try {
    const source = await openAuthorizedFile({ root: scope.docsRoot, input: sourcePath, flags: constants.O_RDONLY });
    try {
      const destination = await openAuthorizedFile({
        root: scope.docsRoot,
        input: destinationPath,
        flags: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        policy: "create",
        mode: 0o600,
      });
      try {
        await destination.handle.writeFile(await source.handle.readFile());
        await destination.handle.sync();
      } finally {
        await destination.handle.close();
      }
    } finally {
      await source.handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") {
      throw new Error("A file with the same name already exists in the destination");
    }
    throw new Error(`Failed to copy file: ${(error as Error).message ?? "unknown error"}`);
  }

  const destinationStats = await stat(destinationPath);

  return {
    path: destinationPath,
    relativePath: toDocsRelativePath(destinationPath, scope),
    displayPath: toDocsDisplayPath(destinationPath, scope),
    name: basename(destinationPath),
    size: destinationStats.size,
    mtimeMs: destinationStats.mtimeMs,
  };
}

async function moveDocsFile(
  pathInput: string | null | undefined,
  targetDirectoryInput: string | null | undefined,
  newNameInput: string | null | undefined,
  scope: WorkspaceScope,
) {
  const sourcePath = await resolveDocsPath(pathInput, scope);
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(sourcePath);
  } catch {
    throw new Error("File not found");
  }

  if (!stats.isFile()) {
    throw new Error("Requested path is not a file");
  }

  const targetDirectory = await ensureDocsDirectory(targetDirectoryInput, scope);
  const destinationName = newNameInput && newNameInput.trim().length > 0
    ? normaliseDocsFileName(newNameInput)
    : basename(sourcePath);
  const destinationPath = normalize(join(targetDirectory, destinationName));

  if (!isWithinDocsRoot(destinationPath, scope)) {
    throw new Error("Invalid destination path");
  }

  if (destinationPath === sourcePath) {
    throw new Error("Destination matches the source file");
  }

  try {
    const reauthorizedSource = await resolveDocsPath(sourcePath, scope);
    const reauthorizedDestination = await resolveDocsPath(destinationPath, scope, "create");
    await rename(reauthorizedSource, reauthorizedDestination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") {
      throw new Error("A file with the same name already exists in the destination");
    }
    if (code === "EXDEV") {
      try {
        await copyDocsFile(sourcePath, targetDirectory, destinationName, scope);
        const reauthorizedSource = await resolveDocsPath(sourcePath, scope);
        await rm(reauthorizedSource, { force: false });
      } catch (copyError) {
        const message = copyError instanceof Error ? copyError.message : "unknown error";
        throw new Error(`Failed to move file: ${message}`);
      }
    } else {
      const message = (error as Error).message ?? "unknown error";
      throw new Error(`Failed to move file: ${message}`);
    }
  }

  const destinationStats = await stat(destinationPath);

  return {
    path: destinationPath,
    relativePath: toDocsRelativePath(destinationPath, scope),
    displayPath: toDocsDisplayPath(destinationPath, scope),
    name: basename(destinationPath),
    size: destinationStats.size,
    mtimeMs: destinationStats.mtimeMs,
  };
}

// ---------- Main handler ----------

/**
 * Main handler for /api/docs/* routes.
 * Returns null if the route doesn't match, otherwise returns a Response.
 */
export async function handleDocsApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: DocsApiContext,
): Promise<Response | null> {
  const pathname = url.pathname;

  if (!pathname.startsWith("/api/docs/")) {
    return null;
  }

  const scope = ctx.resolveWorkspace(authContext);

  // POST /api/docs/directory — create a directory
  if (pathname === "/api/docs/directory" && method === "POST") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.FilesRead, request, url, authContext);
    if (denied) return denied;

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const parent = normaliseOptionalString((payload as Record<string, unknown>).parent);
    const name = (payload as Record<string, unknown>).name;

    try {
      const data = await createDocsDirectory(parent, name, scope);
      return Response.json(data, { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  // GET /api/docs/tree — list directory
  if (pathname === "/api/docs/tree" && method === "GET") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.FilesRead, request, url, authContext);
    if (denied) return denied;

    try {
      const pathParam = url.searchParams.get("path");
      const showHiddenParam = url.searchParams.get("showHidden") ?? "";
      const includeHidden = (() => {
        const value = showHiddenParam.trim().toLowerCase();
        return value === "1" || value === "true" || value === "yes" || value === "on";
      })();
      const data = await listDocsDirectory(pathParam, { includeHidden }, scope, ctx.describeGitRepository);
      return Response.json(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  // POST /api/docs/file — create a file
  if (pathname === "/api/docs/file" && method === "POST") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.FilesWrite, request, url, authContext);
    if (denied) return denied;

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    try {
      const validatedPayload = validateInput(JsonRequestSchema.extend({
        name: z.string().min(1).max(255).refine(name => !/[<>:"|?*\x00]/.test(name)),
        content: z.string().optional(),
        base64: z.string().optional(),
        directory: z.string().max(4096).refine((path) => !/[\x00\r\n]/.test(path), "Invalid path characters detected").optional()
      }), payload);

      const data = await createDocsFile(validatedPayload.directory, validatedPayload.name, {
        content: validatedPayload.content,
        base64: validatedPayload.base64
      }, scope);
      return Response.json(data, { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  // GET /api/docs/file — load file with preview
  if (pathname === "/api/docs/file" && method === "GET") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.FilesRead, request, url, authContext);
    if (denied) return denied;

    const pathParam = url.searchParams.get("path");
    if (!pathParam) {
      return Response.json({ error: "File path is required" }, { status: 400 });
    }
    try {
      const data = await loadDocsFile(pathParam, scope);
      return Response.json(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  // GET /api/docs/file/raw — load file as base64
  if (pathname === "/api/docs/file/raw" && method === "GET") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.FilesRead, request, url, authContext);
    if (denied) return denied;

    const pathParam = url.searchParams.get("path");
    if (!pathParam) {
      return Response.json({ error: "File path is required" }, { status: 400 });
    }
    try {
      const data = await loadDocsFileRaw(pathParam, scope);
      return Response.json(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  // GET /api/docs/file/download — download file
  if (pathname === "/api/docs/file/download" && method === "GET") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.FilesRead, request, url, authContext);
    if (denied) return denied;

    const pathParam = url.searchParams.get("path");
    if (!pathParam) {
      return Response.json({ error: "File path is required" }, { status: 400 });
    }
    try {
      const filePath = await resolveDocsPath(pathParam, scope);
      const opened = await openAuthorizedFile({ root: scope.docsRoot, input: filePath, flags: constants.O_RDONLY });
      const fileStats = opened.stats;
      if (!fileStats.isFile()) {
        await opened.handle.close();
        return Response.json({ error: "Requested path is not a file" }, { status: 400 });
      }
      const fileName = basename(filePath);
      const dispositionMode = url.searchParams.get("inline") === "1" ? "inline" : "attachment";
      const stream = opened.handle.createReadStream({ autoClose: true });
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        headers: {
          "content-disposition": buildContentDisposition(fileName, dispositionMode),
          "content-type": resolveDocsMimeType(filePath),
          "content-length": String(fileStats.size),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  // PUT /api/docs/file — update file
  if (pathname === "/api/docs/file" && method === "PUT") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.FilesWrite, request, url, authContext);
    if (denied) return denied;

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const pathValue = (payload as Record<string, unknown>).path;
    const base64Value = (payload as Record<string, unknown>).base64;
    const expectedMtimeValue = (payload as Record<string, unknown>).expectedMtimeMs;

    const pathParam = typeof pathValue === "string" ? pathValue : null;
    const base64Param = typeof base64Value === "string" ? base64Value : null;
    const expectedMtime =
      typeof expectedMtimeValue === "number" && Number.isFinite(expectedMtimeValue) ? expectedMtimeValue : null;

    try {
      const data = await updateDocsFile(pathParam, base64Param, expectedMtime, scope);
      return Response.json(data, { status: 200 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  // DELETE /api/docs/file — delete file
  if (pathname === "/api/docs/file" && method === "DELETE") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.FilesWrite, request, url, authContext);
    if (denied) return denied;

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const pathValue = (payload as Record<string, unknown>).path;
    const pathParam = typeof pathValue === "string" ? pathValue : null;

    try {
      const data = await deleteDocsFile(pathParam, scope);
      return Response.json(data, { status: 200 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  // POST /api/docs/file/copy — copy file
  if (pathname === "/api/docs/file/copy" && method === "POST") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.FilesWrite, request, url, authContext);
    if (denied) return denied;

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const pathValue = (payload as Record<string, unknown>).path;
    const targetValue =
      (payload as Record<string, unknown>).targetDirectory ?? (payload as Record<string, unknown>).directory;
    const nameValue = (payload as Record<string, unknown>).name;

    const sourcePath = typeof pathValue === "string" ? pathValue : null;
    const destinationPath = typeof targetValue === "string" ? targetValue : null;
    const destinationName = typeof nameValue === "string" ? nameValue : null;

    try {
      const data = await copyDocsFile(sourcePath, destinationPath, destinationName, scope);
      return Response.json(data, { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  // POST /api/docs/file/move — move/rename file
  if (pathname === "/api/docs/file/move" && method === "POST") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.FilesWrite, request, url, authContext);
    if (denied) return denied;

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const pathValue = (payload as Record<string, unknown>).path;
    const targetValue =
      (payload as Record<string, unknown>).targetDirectory ?? (payload as Record<string, unknown>).directory;
    const nameValue = (payload as Record<string, unknown>).name;

    const sourcePath = typeof pathValue === "string" ? pathValue : null;
    const destinationPath = typeof targetValue === "string" ? targetValue : null;
    const destinationName = typeof nameValue === "string" ? nameValue : null;

    try {
      const data = await moveDocsFile(sourcePath, destinationPath, destinationName, scope);
      return Response.json(data, { status: 200 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  // POST /api/docs/git — execute git command
  if (pathname === "/api/docs/git" && method === "POST") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.FilesWrite, request, url, authContext);
    if (denied) return denied;

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const directoryInput =
      normaliseOptionalString((payload as Record<string, unknown>).directory) ??
      normaliseOptionalString((payload as Record<string, unknown>).path);
    const actionInput = normaliseOptionalString((payload as Record<string, unknown>).action);
    const messageInput = normaliseOptionalString((payload as Record<string, unknown>).message);
    const remoteInput = normaliseOptionalString((payload as Record<string, unknown>).remote);
    const remoteUrlInput = normaliseOptionalString((payload as Record<string, unknown>).remoteUrl);
    const branchInput = normaliseOptionalString((payload as Record<string, unknown>).branch);
    const expectedRemoteHostInput = normaliseOptionalString((payload as Record<string, unknown>).expectedRemoteHost);

    if (!directoryInput) {
      return Response.json({ error: "Directory is required" }, { status: 400 });
    }

    if (!actionInput) {
      return Response.json({ error: "Action is required" }, { status: 400 });
    }

    if (!["init", "addAll", "commit", "push", "pushUpstream", "pull", "status", "switchBranch", "listRemotes", "setRemote"].includes(actionInput)) {
      return Response.json({ error: "Unsupported git action" }, { status: 400 });
    }

    let directory: string;
    try {
      directory = await resolveDocsPath(directoryInput, scope);
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }

    try {
      const result = await ctx.executeGitCommand({
        directory,
        action: actionInput as GitCommandAction,
        message: messageInput,
        remote: remoteInput,
        remoteUrl: remoteUrlInput,
        branch: branchInput,
        viewerNpub: authContext.npub ?? null,
        expectedRemoteHost: expectedRemoteHostInput,
      });

      if (result.exitCode !== 0) {
        const message = result.stderr || result.stdout || `Git command failed with exit code ${result.exitCode}`;
        return Response.json(
          { error: message, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
          { status: 400 },
        );
      }

      return Response.json({ exitCode: 0, stdout: result.stdout, stderr: result.stderr }, { status: 200 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  // POST /api/docs/worktrees — create git worktree
  if (pathname === "/api/docs/worktrees" && method === "POST") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.FilesWrite, request, url, authContext);
    if (denied) return denied;

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const directoryInput =
      normaliseOptionalString((payload as Record<string, unknown>).directory) ??
      normaliseOptionalString((payload as Record<string, unknown>).path);
    const branchInput = normaliseOptionalString((payload as Record<string, unknown>).branch);
    const startPointInput =
      normaliseOptionalString((payload as Record<string, unknown>).startPoint) ??
      normaliseOptionalString((payload as Record<string, unknown>).base) ??
      normaliseOptionalString((payload as Record<string, unknown>).from);

    if (!directoryInput) {
      return Response.json({ error: "Directory is required" }, { status: 400 });
    }

    if (!branchInput) {
      return Response.json({ error: "Branch name is required" }, { status: 400 });
    }

    let directory: string;
    try {
      directory = await ctx.ensureDirectory(directoryInput);
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }

    try {
      const result = await ctx.createGitWorktree({
        directory,
        branch: branchInput,
        startPoint: startPointInput,
      });
      return Response.json(result, { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  return null;
}

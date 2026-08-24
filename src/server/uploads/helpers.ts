import { mkdir } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { deriveNpubSegment } from "../../identity/npub-utils";
import type { AgentType } from "../../config";

export type UploadRoots = {
  userIdentityRoot: string;
  attachmentRoot: string;
  imageRoot: string;
};

export type UploadHelpers = ReturnType<typeof createUploadHelpers>;

export const createUploadHelpers = (roots: UploadRoots) => {
  const ensureUserWorkspace = (npub: string | null) => {
    const segment = deriveNpubSegment(npub);
    try {
      mkdirSync(join(roots.userIdentityRoot, segment), { recursive: true });
    } catch (error) {
      console.warn(`[uploads] failed to ensure user base for ${segment}: ${(error as Error).message}`);
    }
    try {
      mkdirSync(join(roots.userIdentityRoot, segment, "logs"), { recursive: true });
    } catch (error) {
      console.warn(`[uploads] failed to ensure user log directory for ${segment}: ${(error as Error).message}`);
    }
    try {
      mkdirSync(join(roots.attachmentRoot, segment), { recursive: true });
    } catch (error) {
      console.warn(`[uploads] failed to ensure attachment root for ${segment}: ${(error as Error).message}`);
    }
    try {
      mkdirSync(join(roots.imageRoot, segment), { recursive: true });
    } catch (error) {
      console.warn(`[uploads] failed to ensure image root for ${segment}: ${(error as Error).message}`);
    }
    return segment;
  };

  const ensureUserUploadDirectory = async (root: string, segment: string, agent: AgentType) => {
    const userRoot = join(root, segment);
    await mkdir(userRoot, { recursive: true });
    const directory = join(userRoot, agent);
    await mkdir(directory, { recursive: true });
    return directory;
  };

  const ensureImageDirectory = async (agent: AgentType, npub: string | null) => {
    const segment = ensureUserWorkspace(npub);
    return await ensureUserUploadDirectory(roots.imageRoot, segment, agent);
  };

  const ensureAttachmentDirectory = async (agent: AgentType, npub: string | null) => {
    const segment = ensureUserWorkspace(npub);
    return await ensureUserUploadDirectory(roots.attachmentRoot, segment, agent);
  };

  const createImageFilename = (name: string, mime: string): string => {
    const originalExt = extname(name) || "";
    if (originalExt) {
      return `${randomUUID()}${originalExt.toLowerCase()}`;
    }
    const inferred = (() => {
      if (!mime) return ".bin";
      const subtype = mime.split("/")[1];
      if (!subtype) return ".bin";
      if (subtype === "jpeg") return ".jpg";
      if (/^[a-z0-9]+$/i.test(subtype)) {
        return `.${subtype.toLowerCase()}`;
      }
      return ".bin";
    })();
    return `${randomUUID()}${inferred}`;
  };

  const createAttachmentFilename = (name: string, mime: string): string => {
    const trimmed = name?.trim() ?? "";
    const clean = trimmed.replace(/[^\w.-]/g, "_");
    const candidateExt = extname(clean);
    if (candidateExt) {
      return `${randomUUID()}${candidateExt.toLowerCase()}`;
    }

    const inferred = (() => {
      if (!mime) return ".bin";
      const subtype = mime.split("/")[1];
      if (!subtype) return ".bin";
      if (/^[a-z0-9]+$/i.test(subtype)) {
        return `.${subtype.toLowerCase()}`;
      }
      return ".bin";
    })();

    return `${randomUUID()}${inferred}`;
  };

  const buildEscapedImageMarkdown = (url: string): string => {
    return `\\![uploaded image]\\(${url})`;
  };

  const buildAgentImagePlaceholder = (agent: AgentType, absolutePath: string, publicPath: string) => {
    const fileUrl = pathToFileURL(absolutePath).toString();
    switch (agent) {
      case "codex":
      case "claude":
      case "gemini":
        return buildEscapedImageMarkdown(fileUrl);
      case "goose":
        return buildEscapedImageMarkdown(publicPath);
      default:
        return publicPath;
    }
  };

  const buildAgentFilePlaceholder = (
    agent: AgentType,
    absolutePath: string,
    publicPath: string,
    originalName: string | undefined,
  ) => {
    const label = originalName && originalName.trim().length > 0 ? originalName.trim() : "uploaded file";
    const fileUrl = pathToFileURL(absolutePath).toString();
    switch (agent) {
      case "codex":
      case "claude":
      case "gemini":
        return `[${label}](${fileUrl})`;
      case "goose":
        return `[${label}](${publicPath})`;
      default:
        return `${label}: ${publicPath}`;
    }
  };

  return {
    ensureUserWorkspace,
    ensureImageDirectory,
    ensureAttachmentDirectory,
    createImageFilename,
    createAttachmentFilename,
    buildEscapedImageMarkdown,
    buildAgentImagePlaceholder,
    buildAgentFilePlaceholder,
  };
};

import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";

export type FilesystemTargetPolicy = "existing" | "create";

export class FilesystemBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilesystemBoundaryError";
  }
}

export function isPathContained(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === "" || (
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(pathFromRoot)
  );
}

async function resolveExistingAncestor(candidate: string): Promise<{
  canonicalPath: string;
  targetExists: boolean;
  targetIsSymlink: boolean;
}> {
  const missingSegments: string[] = [];
  let cursor = candidate;
  let targetExists = true;
  let targetIsSymlink = false;

  while (true) {
    try {
      const metadata = await lstat(cursor);
      targetIsSymlink = targetIsSymlink || (missingSegments.length === 0 && metadata.isSymbolicLink());
      const canonicalAncestor = await realpath(cursor);
      return {
        canonicalPath: normalize(join(canonicalAncestor, ...missingSegments.reverse())),
        targetExists,
        targetIsSymlink,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      if (missingSegments.length === 0) {
        const metadata = await lstat(cursor).catch(() => null);
        targetIsSymlink = metadata?.isSymbolicLink() ?? false;
      }
      targetExists = false;
      const parent = resolve(cursor, "..");
      if (parent === cursor) throw error;
      missingSegments.push(cursor.slice(parent.length).replace(/^[/\\]+/, ""));
      cursor = parent;
    }
  }
}

export async function authorizeFilesystemPath(options: {
  root: string;
  input: string;
  policy: FilesystemTargetPolicy;
  allowAbsoluteInput?: boolean;
}): Promise<string> {
  const rootInput = options.root.trim();
  const pathInput = options.input.trim();
  if (!rootInput || !pathInput) throw new FilesystemBoundaryError("A filesystem path is required");
  if (isAbsolute(pathInput) && options.allowAbsoluteInput === false) {
    throw new FilesystemBoundaryError("Absolute paths are not permitted");
  }

  const lexicalRoot = resolve(rootInput);
  const lexicalTarget = isAbsolute(pathInput) ? normalize(pathInput) : resolve(lexicalRoot, pathInput);
  if (!isPathContained(lexicalRoot, lexicalTarget)) {
    throw new FilesystemBoundaryError("Access outside the authorized directory is not permitted");
  }

  const canonicalRoot = await realpath(lexicalRoot).catch(() => {
    throw new FilesystemBoundaryError("Authorized directory does not exist");
  });
  const resolvedTarget = await resolveExistingAncestor(lexicalTarget).catch(() => {
    throw new FilesystemBoundaryError("Filesystem path could not be resolved safely");
  });
  if (!isPathContained(canonicalRoot, resolvedTarget.canonicalPath)) {
    throw new FilesystemBoundaryError("Access outside the authorized directory is not permitted");
  }
  if (resolvedTarget.targetIsSymlink) {
    throw new FilesystemBoundaryError("Symbolic links are not permitted as filesystem targets");
  }
  if (options.policy === "existing" && !resolvedTarget.targetExists) {
    throw new FilesystemBoundaryError("Filesystem target does not exist");
  }
  return lexicalTarget;
}

export async function openAuthorizedFile(options: {
  root: string;
  input: string;
  flags: number;
  policy?: FilesystemTargetPolicy;
  allowAbsoluteInput?: boolean;
  mode?: number;
}) {
  // Node exposes O_NOFOLLOW but not portable openat(2). Rechecking the canonical
  // path and descriptor identity closes final-link swaps and detects parent swaps
  // around open; pathname-only rename/unlink callers must reauthorize immediately
  // before operating because no descriptor-relative primitive is available here.
  const filePath = await authorizeFilesystemPath({
    root: options.root,
    input: options.input,
    policy: options.policy ?? "existing",
    allowAbsoluteInput: options.allowAbsoluteInput,
  });
  const handle = await open(filePath, options.flags | constants.O_NOFOLLOW, options.mode);
  try {
    const [descriptorStats, pathStats] = await Promise.all([handle.stat(), stat(filePath)]);
    if (!descriptorStats.isFile() || descriptorStats.dev !== pathStats.dev || descriptorStats.ino !== pathStats.ino) {
      throw new FilesystemBoundaryError("Filesystem target changed during authorization");
    }
    await authorizeFilesystemPath({
      root: options.root,
      input: filePath,
      policy: "existing",
      allowAbsoluteInput: true,
    });
    return { filePath, handle, stats: descriptorStats };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function resolveSessionTargetFile(
  workingDirectory: string,
  targetFile: string | null | undefined,
): Promise<string | undefined> {
  const value = targetFile?.trim();
  if (!value) return undefined;
  return authorizeFilesystemPath({
    root: workingDirectory,
    input: value,
    policy: "create",
    allowAbsoluteInput: false,
  });
}

export async function resolveStoredSessionTargetFile(
  workingDirectory: string,
  targetFile: string | null | undefined,
): Promise<string | undefined> {
  const value = targetFile?.trim();
  if (!value) return undefined;
  return authorizeFilesystemPath({
    root: workingDirectory,
    input: value,
    policy: "create",
    allowAbsoluteInput: true,
  });
}

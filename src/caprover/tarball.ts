/**
 * Tarball Creation Utility
 *
 * Creates tar archives from app directories for CapRover deployment.
 * Respects .gitignore patterns and excludes common non-deployable files.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative } from "node:path";
import { spawn } from "node:child_process";

const CAPTAIN_DEFINITION_FILES = ["captain-definition", "captain-definition.json"] as const;
const CAPROVER_INCLUDE_FILE = ".caproverinclude";

/** Default patterns to exclude from deployment tarballs */
const DEFAULT_EXCLUDES = [
  ".git",
  ".git/**",
  "node_modules",
  "node_modules/**",
  ".env",
  ".env.*",
  ".DS_Store",
  "*.log",
  ".idea",
  ".vscode",
  "coverage",
  "dist",
  ".nyc_output",
  "*.sqlite",
  "*.sqlite-journal",
  "*.sqlite-wal",
  "*.sqlite-shm",
];

/**
 * Parse a .gitignore file and return patterns.
 * Simple parser - handles basic patterns, not all gitignore edge cases.
 */
async function parseGitignore(gitignorePath: string): Promise<string[]> {
  try {
    const content = await readFile(gitignorePath, "utf8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch {
    return [];
  }
}

async function parseIncludeFile(includePath: string): Promise<string[]> {
  try {
    const content = await readFile(includePath, "utf8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch {
    return [];
  }
}

/**
 * Check if a path should be excluded based on patterns.
 * Simple matching - checks if path starts with or equals pattern.
 */
function shouldExclude(relativePath: string, patterns: string[]): boolean {
  const normalizedPath = relativePath.replace(/\\/g, "/");

  for (const pattern of patterns) {
    // Remove leading slash if present
    const normalizedPattern = pattern.replace(/^\//, "").replace(/\\/g, "/");

    // Direct match
    if (normalizedPath === normalizedPattern) {
      return true;
    }

    // Directory match (pattern without trailing slash matches directory)
    if (normalizedPath.startsWith(normalizedPattern + "/")) {
      return true;
    }

    // Glob pattern ending with /**
    if (normalizedPattern.endsWith("/**")) {
      const prefix = normalizedPattern.slice(0, -3);
      if (normalizedPath === prefix || normalizedPath.startsWith(prefix + "/")) {
        return true;
      }
    }

    // Simple wildcard at start (e.g., *.log)
    if (normalizedPattern.startsWith("*")) {
      const suffix = normalizedPattern.slice(1);
      if (normalizedPath.endsWith(suffix)) {
        return true;
      }
    }

    // Simple glob anywhere in the path (e.g., deploy-seed/*.seed)
    if (normalizedPattern.includes("*")) {
      const regex = new RegExp(
        "^" + normalizedPattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
      );
      if (regex.test(normalizedPath)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Recursively collect all files to include in tarball.
 */
async function collectFiles(
  dir: string,
  baseDir: string,
  excludePatterns: string[],
): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relativePath = relative(baseDir, fullPath);

    if (shouldExclude(relativePath, excludePatterns)) {
      continue;
    }

    if (entry.isDirectory()) {
      const subFiles = await collectFiles(fullPath, baseDir, excludePatterns);
      files.push(...subFiles);
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  return files;
}

async function collectForcedIncludes(appRoot: string, entries: string[]): Promise<string[]> {
  const files: string[] = [];

  for (const entry of entries) {
    const normalizedEntry = normalize(entry).replace(/\\/g, "/");
    if (
      isAbsolute(normalizedEntry) ||
      normalizedEntry === ".." ||
      normalizedEntry.startsWith("../") ||
      normalizedEntry.includes("/../")
    ) {
      throw new Error(`${CAPROVER_INCLUDE_FILE} contains an unsafe path: ${entry}`);
    }

    const fullPath = join(appRoot, normalizedEntry);
    let fileStat;
    try {
      fileStat = await stat(fullPath);
    } catch {
      continue;
    }

    if (fileStat.isDirectory()) {
      files.push(...await collectFiles(fullPath, appRoot, []));
    } else if (fileStat.isFile()) {
      files.push(relative(appRoot, fullPath));
    }
  }

  return files;
}

function findCaptainDefinitionFile(files: string[]): string | null {
  return CAPTAIN_DEFINITION_FILES.find((file) => files.includes(file)) ?? null;
}

async function readCaptainDefinition(appRoot: string): Promise<{ fileName: string; content: string } | null> {
  for (const fileName of CAPTAIN_DEFINITION_FILES) {
    try {
      return {
        fileName,
        content: await readFile(join(appRoot, fileName), "utf8"),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }

  return null;
}

export interface CreateTarballOptions {
  /** Additional patterns to exclude */
  additionalExcludes?: string[];
  /** Whether to include default excludes (default: true) */
  useDefaultExcludes?: boolean;
  /** Whether to parse .gitignore (default: true) */
  respectGitignore?: boolean;
}

export interface CreateTarballResult {
  /** The tarball as a Buffer */
  buffer: Buffer;
  /** Number of files included */
  fileCount: number;
  /** List of included files (relative paths) */
  files: string[];
}

/**
 * Create a tarball from an app directory.
 *
 * @param appRoot - The root directory of the app
 * @param options - Options for tarball creation
 * @returns The tarball buffer and metadata
 */
export async function createAppTarball(
  appRoot: string,
  options: CreateTarballOptions = {},
): Promise<CreateTarballResult> {
  const {
    additionalExcludes = [],
    useDefaultExcludes = true,
    respectGitignore = true,
  } = options;

  // Build exclude patterns
  const excludePatterns: string[] = [];

  if (useDefaultExcludes) {
    excludePatterns.push(...DEFAULT_EXCLUDES);
  }

  if (respectGitignore) {
    const gitignorePath = join(appRoot, ".gitignore");
    const gitignorePatterns = await parseGitignore(gitignorePath);
    excludePatterns.push(...gitignorePatterns);
  }

  excludePatterns.push(...additionalExcludes);

  // Collect files to include
  const files = await collectFiles(appRoot, appRoot, excludePatterns);
  const forcedIncludes = await collectForcedIncludes(
    appRoot,
    await parseIncludeFile(join(appRoot, CAPROVER_INCLUDE_FILE)),
  );
  for (const forcedFile of forcedIncludes) {
    if (!files.includes(forcedFile)) {
      files.push(forcedFile);
    }
  }

  if (files.length === 0) {
    throw new Error("No files to include in tarball");
  }

  // Verify a CapRover captain definition exists.
  if (!findCaptainDefinitionFile(files)) {
    throw new Error("captain-definition or captain-definition.json is required but was not found or is excluded");
  }

  // Create tarball using system tar command
  const buffer = await createTarBuffer(appRoot, files);

  return {
    buffer,
    fileCount: files.length,
    files,
  };
}

/**
 * Create a tar buffer from a list of files using system tar command.
 */
async function createTarBuffer(baseDir: string, files: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    // Use tar with -T to read file list from stdin
    const tarProcess = spawn("tar", ["-cf", "-", "-C", baseDir, "-T", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    tarProcess.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    let stderr = "";
    tarProcess.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    tarProcess.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`tar command failed with code ${code}: ${stderr}`));
      }
    });

    tarProcess.on("error", (err) => {
      reject(new Error(`Failed to spawn tar: ${err.message}`));
    });

    // Write file list to stdin
    tarProcess.stdin.write(files.join("\n"));
    tarProcess.stdin.end();
  });
}

/**
 * Verify that a directory is suitable for CapRover deployment.
 */
export async function verifyDeployableApp(appRoot: string): Promise<{
  valid: boolean;
  errors: string[];
  warnings: string[];
}> {
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    const captainDef = await readCaptainDefinition(appRoot);
    if (!captainDef) {
      errors.push("captain-definition or captain-definition.json not found");
    } else {
      const def = JSON.parse(captainDef.content);

      if (def.schemaVersion !== 2) {
        errors.push(`${captainDef.fileName} must have schemaVersion: 2`);
      }

      // Check if it specifies a build method
      if (!def.imageName && !def.dockerfilePath && !def.dockerfileLines && !def.templateId) {
        // Need a Dockerfile
        const dockerfilePath = join(appRoot, "Dockerfile");
        try {
          await stat(dockerfilePath);
        } catch {
          errors.push(
            `No build method specified. ${captainDef.fileName} needs imageName, dockerfilePath, dockerfileLines, or a Dockerfile must exist`,
          );
        }
      }
    }
  } catch (err) {
    errors.push(`Invalid captain definition: ${(err as Error).message}`);
  }

  // Check for common issues
  const nodeModulesPath = join(appRoot, "node_modules");
  try {
    await stat(nodeModulesPath);
    warnings.push("node_modules exists - it will be excluded from deployment");
  } catch {
    // Good - no node_modules
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

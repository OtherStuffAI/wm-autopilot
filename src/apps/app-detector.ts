/**
 * App Detection Module
 *
 * Detects project types and infers lifecycle scripts from directory contents.
 * Used by the workspace tree browser to identify importable apps.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import type { AppLifecycleScripts } from "./app-registry";
import { appCommand } from "./app-command";
import { readEcosystemConfig } from "../agents/ecosystem-generator";

export type AppType = "pm2" | "node" | "python" | "rust" | "go" | "make" | "docker";

export interface DetectedApp {
  type: AppType;
  marker: string;
  hasEcosystemConfig: boolean;
}

export interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: TreeNode[];
  appType?: AppType | null;
  isWorktree?: boolean;
  isRegistered?: boolean;
}

/**
 * Marker files for each app type.
 * Order matters - first match wins (pm2 config takes priority over package.json).
 */
const APP_MARKERS: [AppType, string[]][] = [
  ["pm2", ["ecosystem.config.cjs", "ecosystem.config.js"]],
  ["node", ["package.json"]],
  ["python", ["pyproject.toml", "setup.py", "requirements.txt"]],
  ["rust", ["Cargo.toml"]],
  ["go", ["go.mod"]],
  ["make", ["Makefile"]],
  ["docker", ["docker-compose.yml", "docker-compose.yaml", "Dockerfile"]],
];

/**
 * Directories to exclude from scanning.
 */
const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "__pycache__",
  ".pytest_cache",
  "target",
  "vendor",
  ".venv",
  "venv",
  "env",
  ".cache",
  "coverage",
  ".turbo",
  ".vercel",
  ".netlify",
]);

/**
 * Check if a file exists in a directory.
 */
async function fileExists(dirPath: string, fileName: string): Promise<boolean> {
  try {
    const filePath = join(dirPath, fileName);
    const stats = await stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

/**
 * Detect the app type for a directory by checking for marker files.
 */
export async function detectAppType(dirPath: string): Promise<DetectedApp | null> {
  // Check for ecosystem config first (indicates PM2 project)
  let hasEcosystemConfig = false;
  const pm2Markers = APP_MARKERS[0]?.[1] ?? [];
  for (const marker of pm2Markers) {
    if (await fileExists(dirPath, marker)) {
      hasEcosystemConfig = true;
      return {
        type: "pm2",
        marker,
        hasEcosystemConfig: true,
      };
    }
  }

  // Check other app types
  for (const [type, markers] of APP_MARKERS.slice(1)) {
    for (const marker of markers) {
      if (await fileExists(dirPath, marker)) {
        // Also check if there's an ecosystem config alongside
        for (const ecosystemFile of pm2Markers) {
          if (await fileExists(dirPath, ecosystemFile)) {
            hasEcosystemConfig = true;
            break;
          }
        }
        return {
          type,
          marker,
          hasEcosystemConfig,
        };
      }
    }
  }

  return null;
}

/**
 * Infer lifecycle scripts based on app type and directory contents.
 */
export async function inferScripts(
  dirPath: string,
  appType: AppType,
): Promise<AppLifecycleScripts> {
  const scripts: AppLifecycleScripts = {};

  switch (appType) {
    case "pm2": {
      // Try to extract scripts from ecosystem config
      try {
        const ecosystemPath = join(dirPath, "ecosystem.config.cjs");
        const config = await readEcosystemConfig(ecosystemPath);
        const app = config.apps[0];
        if (app) {
          // Build start command from script and args
          scripts.start = appCommand(app.script, ...(app.args ?? []));
        }
      } catch {
        // Fall through to check for package.json
      }

      // Also check for package.json scripts
      const nodeScripts = await inferNodeScripts(dirPath);
      return { ...nodeScripts, ...scripts };
    }

    case "node": {
      return inferNodeScripts(dirPath);
    }

    case "python": {
      scripts.setup = appCommand("pip", "install", "-r", "requirements.txt");
      // Check for common entry points
      if (await fileExists(dirPath, "main.py")) {
        scripts.start = appCommand("python", "main.py");
      } else if (await fileExists(dirPath, "app.py")) {
        scripts.start = appCommand("python", "app.py");
      } else if (await fileExists(dirPath, "manage.py")) {
        scripts.start = appCommand("python", "manage.py", "runserver");
      }
      // Check pyproject.toml for scripts
      try {
        const pyproject = await readFile(join(dirPath, "pyproject.toml"), "utf8");
        if (pyproject.includes("[tool.poetry.scripts]") || pyproject.includes("[project.scripts]")) {
          scripts.start = scripts.start || appCommand("python", "-m", basename(dirPath));
        }
        if (pyproject.includes("build-system")) {
          scripts.build = appCommand("python", "-m", "build");
        }
      } catch {
        // No pyproject.toml
      }
      return scripts;
    }

    case "rust": {
      scripts.start = appCommand("cargo", "run");
      scripts.build = appCommand("cargo", "build", "--release");
      return scripts;
    }

    case "go": {
      scripts.start = appCommand("go", "run", ".");
      scripts.build = appCommand("go", "build", "-o", "app", ".");
      return scripts;
    }

    case "make": {
      // Check Makefile for common targets
      try {
        const makefile = await readFile(join(dirPath, "Makefile"), "utf8");
        if (/^run:/m.test(makefile)) {
          scripts.start = appCommand("make", "run");
        } else if (/^start:/m.test(makefile)) {
          scripts.start = appCommand("make", "start");
        } else if (/^serve:/m.test(makefile)) {
          scripts.start = appCommand("make", "serve");
        }
        if (/^build:/m.test(makefile)) {
          scripts.build = appCommand("make", "build");
        }
        if (/^install:/m.test(makefile)) {
          scripts.setup = appCommand("make", "install");
        } else if (/^setup:/m.test(makefile)) {
          scripts.setup = appCommand("make", "setup");
        }
      } catch {
        scripts.build = appCommand("make");
      }
      return scripts;
    }

    case "docker": {
      scripts.start = appCommand("docker-compose", "up");
      scripts.build = appCommand("docker-compose", "build");
      scripts.stop = appCommand("docker-compose", "down");
      return scripts;
    }

    default:
      return scripts;
  }
}

/**
 * Infer scripts from a Node.js package.json.
 */
async function inferNodeScripts(dirPath: string): Promise<AppLifecycleScripts> {
  const scripts: AppLifecycleScripts = {};

  try {
    const packagePath = join(dirPath, "package.json");
    const contents = await readFile(packagePath, "utf8");
    const pkg = JSON.parse(contents) as { scripts?: Record<string, string> };

    if (pkg.scripts) {
      // Start script - prefer dev for development, then start
      if (pkg.scripts.dev) {
        scripts.start = appCommand("bun", "run", "dev");
      } else if (pkg.scripts.start) {
        scripts.start = appCommand("bun", "run", "start");
      }

      // Build script
      if (pkg.scripts.build) {
        scripts.build = appCommand("bun", "run", "build");
      }

      // Setup script - prefer setup, then install
      if (pkg.scripts.setup) {
        scripts.setup = appCommand("bun", "run", "setup");
      } else {
        scripts.setup = appCommand("bun", "install");
      }

      // Stop script if defined
      if (pkg.scripts.stop) {
        scripts.stop = appCommand("bun", "run", "stop");
      }

      // Restart script if defined
      if (pkg.scripts.restart) {
        scripts.restart = appCommand("bun", "run", "restart");
      }
    } else {
      // No scripts in package.json, use defaults
      scripts.setup = appCommand("bun", "install");
    }
  } catch {
    // No package.json or parse error
    scripts.setup = appCommand("bun", "install");
  }

  return scripts;
}

/**
 * Scan a directory tree recursively, detecting app types.
 */
export async function scanDirectoryTree(
  rootPath: string,
  maxDepth: number = 4,
  registeredPaths: Set<string> = new Set(),
  currentDepth: number = 0,
  isInsideWorktree: boolean = false,
): Promise<TreeNode[]> {
  if (currentDepth >= maxDepth) {
    return [];
  }

  const nodes: TreeNode[] = [];

  try {
    const entries = await readdir(rootPath, { withFileTypes: true });

    // Sort entries: directories first, then alphabetically
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      // Skip hidden files/dirs (except .worktrees)
      if (entry.name.startsWith(".") && entry.name !== ".worktrees") {
        continue;
      }

      // Skip excluded directories
      if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) {
        continue;
      }

      // Skip symlinks
      if (entry.isSymbolicLink()) {
        continue;
      }

      const entryPath = join(rootPath, entry.name);

      if (entry.isDirectory()) {
        const isWorktreeDir = entry.name === ".worktrees";
        const isWorktree = isInsideWorktree || isWorktreeDir;

        // Detect app type
        const detected = await detectAppType(entryPath);
        const appType = detected?.type ?? null;

        // Check if already registered
        const isRegistered = registeredPaths.has(entryPath);

        // Recursively scan children
        const children = await scanDirectoryTree(
          entryPath,
          maxDepth,
          registeredPaths,
          currentDepth + 1,
          isWorktree,
        );

        // Include directory if it has an app type, has children, or is .worktrees
        if (appType || children.length > 0 || isWorktreeDir) {
          nodes.push({
            name: entry.name,
            path: entryPath,
            isDirectory: true,
            children: children.length > 0 ? children : undefined,
            appType,
            isWorktree: isWorktree && !isWorktreeDir,
            isRegistered,
          });
        }
      }
    }
  } catch (error) {
    // Directory not readable, skip silently
    console.warn(`[app-detector] failed to scan ${rootPath}: ${(error as Error).message}`);
  }

  return nodes;
}

/**
 * Get the app type label for display.
 */
export function getAppTypeLabel(appType: AppType): string {
  const labels: Record<AppType, string> = {
    pm2: "PM2",
    node: "Node.js",
    python: "Python",
    rust: "Rust",
    go: "Go",
    make: "Make",
    docker: "Docker",
  };
  return labels[appType] ?? appType;
}

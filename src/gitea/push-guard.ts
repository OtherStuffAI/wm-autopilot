/**
 * Push Safety Guard
 *
 * Pre-push validation that runs before pushToGitea / commitAndPushToGitea.
 * Blocks pushes that would send dangerous files (secrets, node_modules,
 * large binaries) to the remote.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PushGuardResult {
  allowed: boolean;
  issues: PushGuardIssue[];
}

export interface PushGuardIssue {
  severity: "block" | "warn";
  category: "gitignore" | "pattern" | "large-file";
  message: string;
  details?: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum file size in bytes (5 MB). */
const LARGE_FILE_THRESHOLD = 5 * 1024 * 1024;

/** Tracked file patterns that should be gitignored. */
const DANGEROUS_PATTERNS = [
  "node_modules/",
  ".env",
  "data/*.db",
  "*.sqlite",
  "*.sqlite3",
  ".DS_Store",
  "dist/",
  "build/",
  "__pycache__/",
  ".next/",
  "*.log",
  "credentials",
  "*.pem",
  "*.key",
];

/**
 * Convert a simple glob pattern to a RegExp that matches a file path.
 */
function patternToRegex(pattern: string): RegExp {
  // "node_modules/" → matches any path containing node_modules/
  // "*.sqlite"      → matches any file ending in .sqlite
  // ".env"          → matches exactly .env or path ending in /.env
  // "data/*.db"     → matches data/<anything>.db

  let regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex chars (except *)
    .replace(/\*/g, "[^/]*"); // * → match anything except /

  if (pattern.endsWith("/")) {
    // Directory pattern: match anywhere in path
    regex = regex.replace(/\/$/, "(/|$)");
    return new RegExp(`(^|/)${regex}`);
  }

  if (pattern.includes("/")) {
    // Path pattern (e.g. data/*.db): anchor to start
    return new RegExp(`^${regex}$`);
  }

  // File pattern: match as filename component
  return new RegExp(`(^|/)${regex}$`);
}

// Pre-compile patterns
const COMPILED_PATTERNS = DANGEROUS_PATTERNS.map((p) => ({
  pattern: p,
  regex: patternToRegex(p),
}));

// ---------------------------------------------------------------------------
// Guard implementation
// ---------------------------------------------------------------------------

/**
 * Run pre-push safety checks on a git working directory.
 *
 * Checks:
 * 1. Missing .gitignore → block
 * 2. Dangerous tracked file patterns → block
 * 3. Large tracked files (> 5MB) → block
 */
export async function runPushGuard(directory: string): Promise<PushGuardResult> {
  const issues: PushGuardIssue[] = [];

  // 1. Check for .gitignore
  if (!existsSync(join(directory, ".gitignore"))) {
    issues.push({
      severity: "block",
      category: "gitignore",
      message:
        "No .gitignore found. Create a .gitignore to avoid pushing large files, secrets, and build artifacts before pushing.",
    });
  }

  // 2+3. Check tracked files for dangerous patterns and large files
  let trackedFiles: string[] = [];
  try {
    const proc = Bun.spawn(["git", "ls-files"], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    trackedFiles = stdout
      .trim()
      .split("\n")
      .filter((f) => f.length > 0);
  } catch {
    // If git ls-files fails, skip pattern/size checks
    return { allowed: issues.length === 0 || !issues.some((i) => i.severity === "block"), issues };
  }

  if (trackedFiles.length === 0) {
    return { allowed: !issues.some((i) => i.severity === "block"), issues };
  }

  // 2. Check for dangerous patterns
  const matched: string[] = [];
  for (const file of trackedFiles) {
    for (const { regex } of COMPILED_PATTERNS) {
      if (regex.test(file)) {
        matched.push(file);
        break; // one match per file is enough
      }
    }
  }

  if (matched.length > 0) {
    const shown = matched.slice(0, 20);
    const extra = matched.length > 20 ? ` (and ${matched.length - 20} more)` : "";
    issues.push({
      severity: "block",
      category: "pattern",
      message: `Found ${matched.length} tracked file(s) that should be gitignored${extra}`,
      details: shown,
    });
  }

  // 3. Check for large files via git cat-file --batch-check
  try {
    // Build input: one "HEAD:path" per line (or ":path" for staged)
    // Use git ls-tree to get blob hashes, then check sizes
    const lsTree = Bun.spawn(
      ["git", "ls-tree", "-r", "--long", "HEAD"],
      { cwd: directory, stdout: "pipe", stderr: "pipe" },
    );
    const lsOut = await new Response(lsTree.stdout).text();
    await lsTree.exited;

    const largeFiles: string[] = [];
    for (const line of lsOut.trim().split("\n")) {
      if (!line) continue;
      // Format: <mode> <type> <hash> <size>\t<path>
      const match = line.match(/^\d+\s+\w+\s+[a-f0-9]+\s+(\d+)\t(.+)$/);
      if (!match) continue;
      const sizeText = match[1];
      const path = match[2];
      if (!sizeText || !path) continue;
      const size = parseInt(sizeText, 10);
      if (size > LARGE_FILE_THRESHOLD) {
        const mb = (size / (1024 * 1024)).toFixed(1);
        largeFiles.push(`${path} (${mb} MB)`);
      }
    }

    if (largeFiles.length > 0) {
      issues.push({
        severity: "block",
        category: "large-file",
        message: `Found ${largeFiles.length} file(s) larger than 5 MB`,
        details: largeFiles.slice(0, 10),
      });
    }
  } catch {
    // ls-tree might fail on repos with no commits — skip size check
  }

  const blocked = issues.some((i) => i.severity === "block");
  return { allowed: !blocked, issues };
}

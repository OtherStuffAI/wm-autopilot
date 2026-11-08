/**
 * Push Safety Guard
 *
 * Pre-push validation that runs before pushToGitea / commitAndPushToGitea.
 * Blocks pushes that would send dangerous files (secrets, node_modules,
 * large binaries) to the remote.
 */



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
export interface PushReview {
  reviewedLargeFiles?: boolean;
  reviewReason?: string;
}

export const REVIEWED_PUSH_COMMAND = 'bun clis/git-push.ts reviewed-commit-and-push --directory "<repository>" --remote "<remote>" --branch "<branch>" --message "<commit message>" --acknowledge-large-files --review-reason "<reviewer and reason>"';

export class PushReviewError extends Error {}

export function validatePushReview(review: PushReview): void {
  if (review.reviewedLargeFiles !== undefined && typeof review.reviewedLargeFiles !== "boolean") {
    throw new PushReviewError("reviewedLargeFiles must be a boolean");
  }
  if (review.reviewedLargeFiles === true && (typeof review.reviewReason !== "string" || !review.reviewReason.trim())) {
    throw new PushReviewError("Reviewed large-file override requires explicit acknowledgement and a nonempty reviewReason");
  }
  if (review.reviewReason !== undefined && review.reviewedLargeFiles !== true) {
    throw new PushReviewError("reviewReason requires explicit reviewedLargeFiles acknowledgement");
  }
}

/** Inspect the exact committed tree being pushed; fail closed on Git errors. */
export async function runPushGuard(directory: string, review: PushReview = {}, ref = "HEAD"): Promise<PushGuardResult> {
  validatePushReview(review);
  const proc = Bun.spawn(["git", "ls-tree", "-rz", "--long", ref], {
    cwd: directory, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(),
  ]);
  if (await proc.exited !== 0) throw new Error(`Cannot inspect committed push content: ${stderr.trim()}`);
  const files = stdout.split("\0").filter(Boolean).map((entry) => {
    const match = entry.match(/^\d+ (\w+) ([a-f0-9]+)\s+(\d+|-)\t([\s\S]+)$/);
    if (!match) throw new Error("Cannot parse committed push tree");
    return { path: match[4]!, size: Number(match[3]) };
  });
  const issues: PushGuardIssue[] = [];
  if (!files.some((file) => file.path === ".gitignore")) {
    issues.push({ severity: "block", category: "gitignore", message: "No committed .gitignore found. Commit a .gitignore before pushing." });
  }
  const dangerous = files.filter((file) => COMPILED_PATTERNS.some(({ regex }) => regex.test(file.path)));
  if (dangerous.length) issues.push({
    severity: "block", category: "pattern",
    message: `Found ${dangerous.length} tracked file(s) that should be gitignored`,
    details: dangerous.slice(0, 20).map((file) => file.path),
  });
  const large = files.filter((file) => file.size > LARGE_FILE_THRESHOLD);
  if (large.length) issues.push({
    severity: review.reviewedLargeFiles === true ? "warn" : "block", category: "large-file",
    message: review.reviewedLargeFiles === true
      ? `Reviewed large files accepted: ${review.reviewReason!.trim()}`
      : `Found ${large.length} file(s) larger than 5 MB. Review the complete changes and oversized files first. Only after review, run from the Autopilot checkout: ${REVIEWED_PUSH_COMMAND}. Replace placeholders with the explicit target and actual review reason. This commits all nonignored changes and pushes; only file size is overridden. Secret/dangerous patterns and missing .gitignore still block.`,
    details: large.slice(0, 10).map((file) => `${file.path} (${(file.size / (1024 * 1024)).toFixed(1)} MB)`),
  });
  return { allowed: !issues.some((issue) => issue.severity === "block"), issues };
}

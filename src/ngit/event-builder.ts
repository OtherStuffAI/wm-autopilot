/**
 * NIP-34 Event Template Builder
 *
 * Builds unsigned Nostr event templates for git-related events:
 *   - Kind 30617: Repository announcement (addressable)
 *   - Kind 30618: Repository state (branch refs, HEAD)
 *   - Kind 1617:  Patches (git format-patch content)
 *   - Kind 1618:  Pull requests / merge requests
 *   - Kind 1621:  Issues (bug reports, feature requests)
 *   - Kind 1630-1633: Status (open, applied/resolved, closed, draft)
 *
 * Templates are unsigned — they get signed by the user's browser
 * via the existing Tier 2 delegation flow before relay publication.
 *
 * @see https://github.com/nostr-protocol/nips/blob/master/34.md
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const REPO_ANNOUNCEMENT_KIND = 30617;
export const REPO_STATE_KIND = 30618;
export const PATCH_KIND = 1617;
export const PULL_REQUEST_KIND = 1618;
export const ISSUE_KIND = 1621;

/** Status event kinds — value selects the status. */
export const STATUS_OPEN = 1630;
export const STATUS_APPLIED = 1631; // Applied/Merged (patches) or Resolved (issues)
export const STATUS_CLOSED = 1632;
export const STATUS_DRAFT = 1633;

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface RepoAnnouncementInput {
  /** Repository identifier (kebab-case, e.g. "my-project"). Used as the `d` tag. */
  identifier: string;
  /** Human-readable project name. */
  name?: string;
  /** Short description of the repository. */
  description?: string;
  /** Git clone URLs (https, ssh, git://). */
  cloneUrls?: string[];
  /** Web URLs for browsing the repository. */
  webUrls?: string[];
  /** Relay URLs that should monitor for patches and issues. */
  relays?: string[];
  /** Additional maintainer pubkeys (hex). The signing user is always included. */
  maintainers?: string[];
  /** Hashtags / topics for discoverability. */
  hashtags?: string[];
  /** SHA of the earliest unique commit (for the `r` tag with `euc` marker). */
  earliestUniqueCommit?: string;
}

export interface RepoStateInput {
  /** Repository identifier — must match the `d` tag of the announcement. */
  identifier: string;
  /** Map of branch/tag names to commit SHAs. */
  refs: Record<string, string>;
  /** Default branch (e.g. "main"). Included as a HEAD tag. */
  head?: string;
  /** Relay URLs to publish to. */
  relays?: string[];
}

export interface PatchInput {
  /** Repository reference: "30617:<owner-pubkey-hex>:<identifier>". */
  repoReference: string;
  /** Earliest unique commit SHA of the repository. */
  earliestUniqueCommit: string;
  /** Hex pubkey of the repository owner (for `p` tag). */
  repoOwnerPubkey: string;
  /** The git format-patch content. Must be < 60kb. */
  patchContent: string;
  /** True if this is the first (root) patch in the series. */
  isRoot?: boolean;
  /** True if this is the root of a revision to an earlier proposal. */
  isRootRevision?: boolean;
  /** Commit SHA this patch represents. */
  commitId?: string;
  /** Parent commit SHA. */
  parentCommitId?: string;
  /** Committer details: [name, email, timestamp, timezone-offset-minutes]. */
  committer?: { name: string; email: string; timestamp: string; timezone: string };
  /** Event ID of the previous patch in the series (NIP-10 reply threading). */
  replyTo?: string;
  /** Additional recipient pubkeys (hex). */
  recipients?: string[];
}

export interface PullRequestInput {
  /** Repository reference: "30617:<owner-pubkey-hex>:<identifier>". */
  repoReference: string;
  /** Earliest unique commit SHA of the repository. */
  earliestUniqueCommit: string;
  /** Hex pubkey of the repository owner (for `p` tag). */
  repoOwnerPubkey: string;
  /** Markdown description of the pull request. */
  description: string;
  /** PR subject / title. */
  subject: string;
  /** Branch tip commit SHA. */
  commitId: string;
  /** Git clone URLs where the branch can be fetched. */
  cloneUrls: string[];
  /** Branch name (e.g. "feature/my-feature"). */
  branchName?: string;
  /** Merge base commit SHA. */
  mergeBase?: string;
  /** Labels / topics for the PR. */
  labels?: string[];
  /** Event ID of a root patch this PR replaces. */
  replacesPatchId?: string;
  /** Additional recipient pubkeys (hex). */
  recipients?: string[];
}

export interface IssueInput {
  /** Repository reference: "30617:<owner-pubkey-hex>:<identifier>". */
  repoReference: string;
  /** Hex pubkey of the repository owner (for `p` tag). */
  repoOwnerPubkey: string;
  /** Markdown content of the issue. */
  content: string;
  /** Issue subject / title. */
  subject?: string;
  /** Labels for the issue (e.g. "bug", "enhancement"). */
  labels?: string[];
}

export type StatusValue = "open" | "applied" | "closed" | "draft";

export interface StatusInput {
  /** Event ID of the target patch, PR, or issue (root event). */
  targetEventId: string;
  /** The status to set. */
  status: StatusValue;
  /** Optional markdown comment. */
  content?: string;
  /** Repository reference (optional but recommended). */
  repoReference?: string;
  /** Earliest unique commit SHA (optional). */
  earliestUniqueCommit?: string;
  /** Hex pubkey of the repository owner. */
  repoOwnerPubkey?: string;
  /** Hex pubkey of the target event's author. */
  targetAuthorPubkey?: string;
  /** Event ID of an accepted revision root (for applied status). */
  acceptedRevisionId?: string;
  /** Merge commit SHA (for applied/merged patches). */
  mergeCommit?: string;
  /** Applied-as commit SHAs (for applied patches). */
  appliedAsCommits?: string[];
  /** Patch event IDs that were applied (for `q` tags). */
  appliedPatchIds?: Array<{ eventId: string; relay?: string; pubkey?: string }>;
}

// ---------------------------------------------------------------------------
// Unsigned event template shape
// ---------------------------------------------------------------------------

export interface UnsignedEventTemplate {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Build an unsigned kind 30617 repository announcement event.
 */
export function buildRepoAnnouncement(input: RepoAnnouncementInput): UnsignedEventTemplate {
  const tags: string[][] = [
    ["d", input.identifier],
  ];

  if (input.name) {
    tags.push(["name", input.name]);
  }

  if (input.description) {
    tags.push(["description", input.description]);
  }

  if (input.cloneUrls) {
    for (const url of input.cloneUrls) {
      tags.push(["clone", url]);
    }
  }

  if (input.webUrls) {
    for (const url of input.webUrls) {
      tags.push(["web", url]);
    }
  }

  if (input.relays) {
    tags.push(["relays", ...input.relays]);
  }

  if (input.maintainers) {
    for (const pubkey of input.maintainers) {
      tags.push(["maintainers", pubkey]);
    }
  }

  if (input.earliestUniqueCommit) {
    tags.push(["r", input.earliestUniqueCommit, "euc"]);
  }

  if (input.hashtags) {
    for (const tag of input.hashtags) {
      tags.push(["t", tag.toLowerCase()]);
    }
  }

  return {
    kind: REPO_ANNOUNCEMENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: input.description ?? "",
  };
}

/**
 * Build an unsigned kind 30618 repository state event.
 */
export function buildRepoState(input: RepoStateInput): UnsignedEventTemplate {
  const tags: string[][] = [
    ["d", input.identifier],
  ];

  // Add refs — each branch/tag gets its own refs tag
  for (const [name, commitSha] of Object.entries(input.refs)) {
    tags.push(["refs", name, commitSha]);
  }

  if (input.head) {
    tags.push(["HEAD", `refs/heads/${input.head}`]);
  }

  if (input.relays) {
    tags.push(["relays", ...input.relays]);
  }

  return {
    kind: REPO_STATE_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: "",
  };
}

/**
 * Build an unsigned kind 1617 patch event.
 */
export function buildPatch(input: PatchInput): UnsignedEventTemplate {
  const tags: string[][] = [
    ["a", input.repoReference],
    ["r", input.earliestUniqueCommit],
    ["p", input.repoOwnerPubkey],
  ];

  if (input.recipients) {
    for (const pubkey of input.recipients) {
      tags.push(["p", pubkey]);
    }
  }

  if (input.isRoot) {
    tags.push(["t", "root"]);
  }
  if (input.isRootRevision) {
    tags.push(["t", "root-revision"]);
  }

  if (input.commitId) {
    tags.push(["commit", input.commitId]);
    tags.push(["r", input.commitId]);
  }
  if (input.parentCommitId) {
    tags.push(["parent-commit", input.parentCommitId]);
  }

  if (input.committer) {
    tags.push([
      "committer",
      input.committer.name,
      input.committer.email,
      input.committer.timestamp,
      input.committer.timezone,
    ]);
  }

  // NIP-10 reply threading for patch series
  if (input.replyTo) {
    tags.push(["e", input.replyTo, "", "reply"]);
  }

  return {
    kind: PATCH_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: input.patchContent,
  };
}

/**
 * Build an unsigned kind 1618 pull request event.
 */
export function buildPullRequest(input: PullRequestInput): UnsignedEventTemplate {
  const tags: string[][] = [
    ["a", input.repoReference],
    ["r", input.earliestUniqueCommit],
    ["p", input.repoOwnerPubkey],
  ];

  if (input.recipients) {
    for (const pubkey of input.recipients) {
      tags.push(["p", pubkey]);
    }
  }

  tags.push(["subject", input.subject]);
  tags.push(["c", input.commitId]);

  for (const url of input.cloneUrls) {
    tags.push(["clone", url]);
  }

  if (input.branchName) {
    tags.push(["branch-name", input.branchName]);
  }
  if (input.mergeBase) {
    tags.push(["merge-base", input.mergeBase]);
  }

  if (input.labels) {
    for (const label of input.labels) {
      tags.push(["t", label.toLowerCase()]);
    }
  }

  if (input.replacesPatchId) {
    tags.push(["e", input.replacesPatchId]);
  }

  return {
    kind: PULL_REQUEST_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: input.description,
  };
}

/**
 * Build an unsigned kind 1621 issue event.
 */
export function buildIssue(input: IssueInput): UnsignedEventTemplate {
  const tags: string[][] = [
    ["a", input.repoReference],
    ["p", input.repoOwnerPubkey],
  ];

  if (input.subject) {
    tags.push(["subject", input.subject]);
  }

  if (input.labels) {
    for (const label of input.labels) {
      tags.push(["t", label.toLowerCase()]);
    }
  }

  return {
    kind: ISSUE_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: input.content,
  };
}

/**
 * Map status string to the correct event kind.
 */
function statusToKind(status: StatusValue): number {
  switch (status) {
    case "open": return STATUS_OPEN;
    case "applied": return STATUS_APPLIED;
    case "closed": return STATUS_CLOSED;
    case "draft": return STATUS_DRAFT;
  }
}

/**
 * Build an unsigned kind 1630-1633 status event.
 */
export function buildStatus(input: StatusInput): UnsignedEventTemplate {
  const tags: string[][] = [
    ["e", input.targetEventId, "", "root"],
  ];

  if (input.acceptedRevisionId) {
    tags.push(["e", input.acceptedRevisionId, "", "reply"]);
  }

  if (input.repoOwnerPubkey) {
    tags.push(["p", input.repoOwnerPubkey]);
  }
  if (input.targetAuthorPubkey) {
    tags.push(["p", input.targetAuthorPubkey]);
  }

  if (input.repoReference) {
    tags.push(["a", input.repoReference]);
  }
  if (input.earliestUniqueCommit) {
    tags.push(["r", input.earliestUniqueCommit]);
  }

  // Applied/merged metadata (kind 1631)
  if (input.appliedPatchIds) {
    for (const patch of input.appliedPatchIds) {
      tags.push(["q", patch.eventId, patch.relay ?? "", patch.pubkey ?? ""]);
    }
  }
  if (input.mergeCommit) {
    tags.push(["merge-commit", input.mergeCommit]);
    tags.push(["r", input.mergeCommit]);
  }
  if (input.appliedAsCommits) {
    tags.push(["applied-as-commits", ...input.appliedAsCommits]);
    for (const commitId of input.appliedAsCommits) {
      tags.push(["r", commitId]);
    }
  }

  return {
    kind: statusToKind(input.status),
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: input.content ?? "",
  };
}

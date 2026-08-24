/**
 * ngit API Handler
 *
 * HTTP handler for /api/ngit/* routes. Builds NIP-34 event
 * templates, delegates signing to the user's browser via the
 * existing Tier 2 pending-request + SSE flow, then publishes
 * signed events to Nostr relays.
 *
 * Follows the same factory pattern as nip98-api.ts.
 */

import type { SessionSnapshot } from "../agents/process-manager";
import type { Nip98GrantStore } from "../mcp/grants-store";
import { pendingSignRequests } from "../mcp/pending-requests";
import { browserSubscribers } from "../mcp/browser-subscribers";
import {
  buildRepoAnnouncement,
  buildRepoState,
  buildPatch,
  buildPullRequest,
  buildIssue,
  buildStatus,
  REPO_ANNOUNCEMENT_KIND,
  REPO_STATE_KIND,
  PATCH_KIND,
  PULL_REQUEST_KIND,
  ISSUE_KIND,
} from "./event-builder";
import type {
  RepoAnnouncementInput,
  RepoStateInput,
  PatchInput,
  PullRequestInput,
  IssueInput,
  StatusInput,
  StatusValue,
  UnsignedEventTemplate,
} from "./event-builder";
import { publishToRelays, queryRelays } from "./relay-publisher";
import type { SignedEvent } from "./relay-publisher";
import { getOrCreateRepo, isGiteaConfigured } from "../gitea/gitea-client";
import type { GiteaConfig } from "../gitea/gitea-client";
import { parseBody, jsonError } from "../utils/request-utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Synthetic domain for ngit grants — not a real HTTP domain. */
export const NGIT_GRANT_DOMAIN = "nostr.git";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface NgitApiDependencies {
  grantsStore: Nip98GrantStore;
  getSession: (sessionId: string) => SessionSnapshot | null;
  /** Default relay list from config.connectRelays. */
  defaultRelays: string[];
  /** Gitea configuration for automatic repo provisioning. */
  gitea: Partial<GiteaConfig>;
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Request the user's browser to sign an arbitrary Nostr event template.
 *
 * Reuses the same pending-request + SSE infrastructure as NIP-98 Tier 2,
 * but sends a `nostr:sign_request` type so the browser listener can
 * distinguish it from NIP-98 HTTP auth events.
 */
async function requestBrowserSign(
  eventTemplate: UnsignedEventTemplate,
  npub: string,
  grantId: string,
  description: string,
): Promise<SignedEvent> {
  if (!browserSubscribers.hasSubscriber(npub)) {
    throw new Error(
      "No active browser session for this user. Open the Wingman UI to enable signing.",
    );
  }

  const { requestId, promise } = pendingSignRequests.create(npub);

  const signRequest = {
    type: "nostr:sign_request" as const,
    requestId,
    grantId,
    description,
    eventTemplate,
  };

  const delivered = browserSubscribers.send(npub, signRequest);
  if (!delivered) {
    pendingSignRequests.reject(requestId, "Failed to deliver signing request to browser");
    throw new Error("Browser subscriber disconnected before delivery");
  }

  console.log(
    `[ngit-api] Sign request ${requestId} sent to browser (kind=${eventTemplate.kind}, npub=${npub.slice(0, 20)}…)`,
  );

  const signedEvent = await promise;
  return signedEvent as unknown as SignedEvent;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createNgitApiHandler(deps: NgitApiDependencies) {
  return async (
    request: Request,
    url: URL,
    method: HttpMethod,
  ): Promise<Response | null> => {
    if (!url.pathname.startsWith("/api/ngit")) {
      return null;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    // segments: ["api", "ngit", ...]

    try {
      // POST /api/ngit/init
      if (segments.length === 3 && segments[2] === "init" && method === "POST") {
        return await handleInit(deps, request);
      }

      // POST /api/ngit/publish-repo
      if (segments.length === 3 && segments[2] === "publish-repo" && method === "POST") {
        return await handlePublishRepo(deps, request);
      }

      // POST /api/ngit/push-state
      if (segments.length === 3 && segments[2] === "push-state" && method === "POST") {
        return await handlePushState(deps, request);
      }

      // POST /api/ngit/send-patch
      if (segments.length === 3 && segments[2] === "send-patch" && method === "POST") {
        return await handleSendPatch(deps, request);
      }

      // POST /api/ngit/create-pr
      if (segments.length === 3 && segments[2] === "create-pr" && method === "POST") {
        return await handleCreatePR(deps, request);
      }

      // POST /api/ngit/create-issue
      if (segments.length === 3 && segments[2] === "create-issue" && method === "POST") {
        return await handleCreateIssue(deps, request);
      }

      // POST /api/ngit/set-status
      if (segments.length === 3 && segments[2] === "set-status" && method === "POST") {
        return await handleSetStatus(deps, request);
      }

      // GET /api/ngit/repos?sessionId=...&pubkey=...
      if (segments.length === 3 && segments[2] === "repos" && method === "GET") {
        return await handleListRepos(deps, url);
      }

      // GET /api/ngit/proposals?sessionId=...&repo_reference=...
      if (segments.length === 3 && segments[2] === "proposals" && method === "GET") {
        return await handleListProposals(deps, url);
      }

      return jsonError("Not found", 404);
    } catch (err) {
      console.error("[ngit-api] Error:", err);
      return jsonError((err as Error).message, 500);
    }
  };
}

// ---------------------------------------------------------------------------
// Shared validation
// ---------------------------------------------------------------------------

interface ValidatedSession {
  session: SessionSnapshot;
  sessionId: string;
  npub: string;
  grantId: string;
}

/**
 * Validate session, npub, and grant for ngit operations.
 */
function validateSessionAndGrant(
  deps: NgitApiDependencies,
  sessionId: string,
): ValidatedSession {
  const session = deps.getSession(sessionId);
  if (!session) {
    throw Object.assign(new Error("Unknown session"), { status: 404 });
  }

  if (!session.npub) {
    throw Object.assign(
      new Error("Session has no associated user — cannot sign NIP-34 events"),
      { status: 403 },
    );
  }

  const grant = deps.grantsStore.findActiveGrant(NGIT_GRANT_DOMAIN, session.npub, sessionId);
  if (!grant) {
    throw Object.assign(
      new Error(
        `No active grant for ${NGIT_GRANT_DOMAIN}. ` +
        `Call request_api_access with domain="${NGIT_GRANT_DOMAIN}" first.`,
      ),
      { status: 403 },
    );
  }

  return { session, sessionId, npub: session.npub, grantId: grant.id };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * POST /api/ngit/publish-repo
 *
 * Build a kind 30617 repo announcement, sign via browser, publish to relays.
 */
async function handlePublishRepo(
  deps: NgitApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;

  if (!sessionId) {
    return jsonError("sessionId is required", 400);
  }

  const identifier = body.identifier as string | undefined;
  if (!identifier) {
    return jsonError("identifier is required", 400);
  }

  let validated: ValidatedSession;
  try {
    validated = validateSessionAndGrant(deps, sessionId);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return jsonError((err as Error).message, status);
  }

  // Merge caller-provided relays with defaults
  const callerRelays = body.relays as string[] | undefined;
  const relays = callerRelays && callerRelays.length > 0
    ? callerRelays
    : deps.defaultRelays;

  const input: RepoAnnouncementInput = {
    identifier,
    name: body.name as string | undefined,
    description: body.description as string | undefined,
    cloneUrls: body.clone_urls as string[] | undefined,
    webUrls: body.web_urls as string[] | undefined,
    relays,
    maintainers: body.maintainers as string[] | undefined,
    hashtags: body.hashtags as string[] | undefined,
    earliestUniqueCommit: body.earliest_unique_commit as string | undefined,
  };

  const eventTemplate = buildRepoAnnouncement(input);

  try {
    const signedEvent = await requestBrowserSign(
      eventTemplate,
      validated.npub,
      validated.grantId,
      `Publish git repository "${input.name ?? identifier}" to Nostr (NIP-34)`,
    );

    const publishResult = await publishToRelays(signedEvent, relays);

    console.log(
      `[ngit-api] Repo announcement published: ${identifier} → ${publishResult.successes}/${relays.length} relays`,
    );

    return Response.json({
      eventId: signedEvent.id,
      identifier,
      kind: REPO_ANNOUNCEMENT_KIND,
      relays: publishResult.results,
      successes: publishResult.successes,
      failures: publishResult.failures,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Signing or publishing failed";
    console.warn(`[ngit-api] Publish repo failed: ${message}`);
    return jsonError(message, 502);
  }
}

/**
 * POST /api/ngit/push-state
 *
 * Build a kind 30618 repo state event, sign via browser, publish to relays.
 */
async function handlePushState(
  deps: NgitApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;

  if (!sessionId) {
    return jsonError("sessionId is required", 400);
  }

  const identifier = body.identifier as string | undefined;
  const refs = body.refs as Record<string, string> | undefined;

  if (!identifier) {
    return jsonError("identifier is required", 400);
  }
  if (!refs || typeof refs !== "object" || Object.keys(refs).length === 0) {
    return jsonError("refs is required and must be a non-empty object (branch → commit SHA)", 400);
  }

  let validated: ValidatedSession;
  try {
    validated = validateSessionAndGrant(deps, sessionId);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return jsonError((err as Error).message, status);
  }

  const callerRelays = body.relays as string[] | undefined;
  const relays = callerRelays && callerRelays.length > 0
    ? callerRelays
    : deps.defaultRelays;

  const input: RepoStateInput = {
    identifier,
    refs,
    head: body.head as string | undefined,
    relays,
  };

  const eventTemplate = buildRepoState(input);

  try {
    const signedEvent = await requestBrowserSign(
      eventTemplate,
      validated.npub,
      validated.grantId,
      `Push repository state for "${identifier}" to Nostr (NIP-34)`,
    );

    const publishResult = await publishToRelays(signedEvent, relays);

    console.log(
      `[ngit-api] Repo state published: ${identifier} (${Object.keys(refs).length} refs) → ${publishResult.successes}/${relays.length} relays`,
    );

    return Response.json({
      eventId: signedEvent.id,
      identifier,
      kind: REPO_STATE_KIND,
      refsCount: Object.keys(refs).length,
      relays: publishResult.results,
      successes: publishResult.successes,
      failures: publishResult.failures,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Signing or publishing failed";
    console.warn(`[ngit-api] Push state failed: ${message}`);
    return jsonError(message, 502);
  }
}

/**
 * GET /api/ngit/repos?sessionId=...&pubkey=...
 *
 * Query relays for kind 30617 repository announcements.
 * If pubkey is omitted, uses the session user's pubkey.
 */
async function handleListRepos(
  deps: NgitApiDependencies,
  url: URL,
): Promise<Response> {
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    return jsonError("sessionId query parameter is required", 400);
  }

  const session = deps.getSession(sessionId);
  if (!session) {
    return jsonError("Unknown session", 404);
  }

  // Use explicit pubkey or fall back to session user
  let authorHex = url.searchParams.get("pubkey");
  if (!authorHex && session.npub) {
    // Convert npub to hex for the relay filter
    try {
      const { nip19 } = await import("nostr-tools");
      const decoded = nip19.decode(session.npub);
      if (decoded.type === "npub") {
        authorHex = decoded.data as string;
      }
    } catch {
      return jsonError("Failed to decode user npub", 500);
    }
  }

  if (!authorHex) {
    return jsonError("No pubkey available — provide pubkey param or log in", 400);
  }

  const relayParam = url.searchParams.get("relays");
  const relays = relayParam
    ? relayParam.split(",").map((r) => r.trim()).filter(Boolean)
    : deps.defaultRelays;

  try {
    const events = await queryRelays(relays, {
      kinds: [REPO_ANNOUNCEMENT_KIND],
      authors: [authorHex],
      limit: 50,
    });

    const repos = events.map((e) => ({
      eventId: e.id,
      identifier: e.tags.find((t) => t[0] === "d")?.[1] ?? "",
      name: e.tags.find((t) => t[0] === "name")?.[1],
      description: e.tags.find((t) => t[0] === "description")?.[1],
      cloneUrls: e.tags.filter((t) => t[0] === "clone").map((t) => t[1]),
      webUrls: e.tags.filter((t) => t[0] === "web").map((t) => t[1]),
      relays: e.tags.find((t) => t[0] === "relays")?.slice(1) ?? [],
      maintainers: e.tags.filter((t) => t[0] === "maintainers").map((t) => t[1]),
      hashtags: e.tags.filter((t) => t[0] === "t").map((t) => t[1]),
      createdAt: e.created_at,
      pubkey: e.pubkey,
    }));

    return Response.json({ repos, count: repos.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Relay query failed";
    console.warn(`[ngit-api] List repos failed: ${message}`);
    return jsonError(message, 502);
  }
}

/**
 * POST /api/ngit/init
 *
 * Full project initialization:
 *   Step 0 (optional): Create repo on Gitea if configured and no clone_urls provided
 *   Step 1: Publish kind 30617 repo announcement to Nostr
 *   Step 2: Publish kind 30618 repo state to Nostr
 *
 * Returns clone URLs and event IDs so the agent can set up the git remote
 * and push locally.
 */
async function handleInit(
  deps: NgitApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;

  if (!sessionId) return jsonError("sessionId is required", 400);

  const identifier = body.identifier as string | undefined;
  if (!identifier) return jsonError("identifier is required", 400);

  const refs = body.refs as Record<string, string> | undefined;
  if (!refs || typeof refs !== "object" || Object.keys(refs).length === 0) {
    return jsonError("refs is required and must be a non-empty object (branch → commit SHA)", 400);
  }

  let validated: ValidatedSession;
  try {
    validated = validateSessionAndGrant(deps, sessionId);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return jsonError((err as Error).message, status);
  }

  const callerRelays = body.relays as string[] | undefined;
  const relays = callerRelays && callerRelays.length > 0
    ? callerRelays
    : deps.defaultRelays;

  // --- Step 0: Create Gitea repo if configured and no clone_urls provided ---
  let cloneUrls = body.clone_urls as string[] | undefined;
  let webUrls = body.web_urls as string[] | undefined;
  let giteaResult: { cloneUrl: string; sshUrl: string; htmlUrl: string; created: boolean } | null = null;

  const createRemote = body.create_remote !== false; // default true
  if (createRemote && (!cloneUrls || cloneUrls.length === 0) && isGiteaConfigured(deps.gitea)) {
    try {
      const { repo, created } = await getOrCreateRepo(deps.gitea, {
        name: identifier,
        description: body.description as string | undefined,
        isPrivate: false,
      });

      giteaResult = {
        cloneUrl: repo.cloneUrl,
        sshUrl: repo.sshUrl,
        htmlUrl: repo.htmlUrl,
        created,
      };

      // Use Gitea URLs as the clone/web URLs for the Nostr announcement
      cloneUrls = [repo.cloneUrl];
      webUrls = [repo.htmlUrl];

      console.log(
        `[ngit-api] Init step 0: Gitea repo ${created ? "created" : "found"}: ${repo.fullName} (${repo.cloneUrl})`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Gitea repo creation failed";
      console.warn(`[ngit-api] Init step 0 (Gitea) failed: ${message}`);
      return jsonError(`Gitea repo creation failed: ${message}`, 502);
    }
  }

  // --- Step 1: Repo announcement (kind 30617) ---
  const announcementInput: RepoAnnouncementInput = {
    identifier,
    name: body.name as string | undefined,
    description: body.description as string | undefined,
    cloneUrls,
    webUrls,
    relays,
    maintainers: body.maintainers as string[] | undefined,
    hashtags: body.hashtags as string[] | undefined,
    earliestUniqueCommit: body.earliest_unique_commit as string | undefined,
  };

  const announcementTemplate = buildRepoAnnouncement(announcementInput);

  let announcementEventId: string;
  let announcementPublishResult: Awaited<ReturnType<typeof publishToRelays>>;

  try {
    const { signedEvent, publishResult } = await signAndPublish(
      announcementTemplate,
      validated.npub,
      validated.grantId,
      `Initialize git repository "${announcementInput.name ?? identifier}" on Nostr (NIP-34)`,
      relays,
    );
    announcementEventId = signedEvent.id;
    announcementPublishResult = publishResult;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Repo announcement signing/publishing failed";
    console.warn(`[ngit-api] Init step 1 (announcement) failed: ${message}`);
    return jsonError(message, 502);
  }

  console.log(
    `[ngit-api] Init step 1: Repo announcement published: ${identifier} → ${announcementPublishResult.successes}/${relays.length} relays`,
  );

  // --- Step 2: Repo state (kind 30618) ---
  const stateInput: RepoStateInput = {
    identifier,
    refs,
    head: body.head as string | undefined,
    relays,
  };

  const stateTemplate = buildRepoState(stateInput);

  let stateEventId: string;
  let statePublishResult: Awaited<ReturnType<typeof publishToRelays>>;

  try {
    const { signedEvent, publishResult } = await signAndPublish(
      stateTemplate,
      validated.npub,
      validated.grantId,
      `Push initial state for "${identifier}" to Nostr (NIP-34)`,
      relays,
    );
    stateEventId = signedEvent.id;
    statePublishResult = publishResult;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Repo state signing/publishing failed";
    console.warn(`[ngit-api] Init step 2 (state) failed: ${message}`);
    return Response.json({
      partial: true,
      gitea: giteaResult,
      announcement: {
        eventId: announcementEventId,
        kind: REPO_ANNOUNCEMENT_KIND,
        successes: announcementPublishResult.successes,
        failures: announcementPublishResult.failures,
      },
      state: { error: message },
      identifier,
    }, { status: 207 });
  }

  console.log(
    `[ngit-api] Init step 2: Repo state published: ${identifier} (${Object.keys(refs).length} refs) → ${statePublishResult.successes}/${relays.length} relays`,
  );

  return Response.json({
    identifier,
    gitea: giteaResult,
    announcement: {
      eventId: announcementEventId,
      kind: REPO_ANNOUNCEMENT_KIND,
      relays: announcementPublishResult.results,
      successes: announcementPublishResult.successes,
      failures: announcementPublishResult.failures,
    },
    state: {
      eventId: stateEventId,
      kind: REPO_STATE_KIND,
      refsCount: Object.keys(refs).length,
      relays: statePublishResult.results,
      successes: statePublishResult.successes,
      failures: statePublishResult.failures,
    },
  });
}

// ---------------------------------------------------------------------------
// Phase 2 route handlers
// ---------------------------------------------------------------------------

/**
 * Helper to extract relays from request body, falling back to defaults.
 */
function resolveRelays(body: Record<string, unknown>, defaults: string[]): string[] {
  const callerRelays = body.relays as string[] | undefined;
  return callerRelays && callerRelays.length > 0 ? callerRelays : defaults;
}

/**
 * Shared sign-and-publish flow. Builds event, signs via browser, publishes to relays.
 */
async function signAndPublish(
  eventTemplate: UnsignedEventTemplate,
  npub: string,
  grantId: string,
  description: string,
  relays: string[],
): Promise<{ signedEvent: SignedEvent; publishResult: Awaited<ReturnType<typeof publishToRelays>> }> {
  const signedEvent = await requestBrowserSign(eventTemplate, npub, grantId, description);
  const publishResult = await publishToRelays(signedEvent, relays);
  return { signedEvent, publishResult };
}

/**
 * POST /api/ngit/send-patch
 *
 * Build a kind 1617 patch event, sign via browser, publish to relays.
 */
async function handleSendPatch(
  deps: NgitApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;

  if (!sessionId) return jsonError("sessionId is required", 400);

  const repoReference = body.repo_reference as string | undefined;
  const patchContent = body.patch_content as string | undefined;
  const earliestUniqueCommit = body.earliest_unique_commit as string | undefined;
  const repoOwnerPubkey = body.repo_owner_pubkey as string | undefined;

  if (!repoReference) return jsonError("repo_reference is required", 400);
  if (!patchContent) return jsonError("patch_content is required", 400);
  if (!earliestUniqueCommit) return jsonError("earliest_unique_commit is required", 400);
  if (!repoOwnerPubkey) return jsonError("repo_owner_pubkey is required", 400);

  if (patchContent.length > 60_000) {
    return jsonError("Patch content exceeds 60kb limit", 400);
  }

  let validated: ValidatedSession;
  try {
    validated = validateSessionAndGrant(deps, sessionId);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return jsonError((err as Error).message, status);
  }

  const relays = resolveRelays(body, deps.defaultRelays);

  const input: PatchInput = {
    repoReference,
    earliestUniqueCommit,
    repoOwnerPubkey,
    patchContent,
    isRoot: body.is_root as boolean | undefined,
    isRootRevision: body.is_root_revision as boolean | undefined,
    commitId: body.commit_id as string | undefined,
    parentCommitId: body.parent_commit_id as string | undefined,
    committer: body.committer as PatchInput["committer"],
    replyTo: body.reply_to as string | undefined,
    recipients: body.recipients as string[] | undefined,
  };

  const eventTemplate = buildPatch(input);

  try {
    const { signedEvent, publishResult } = await signAndPublish(
      eventTemplate,
      validated.npub,
      validated.grantId,
      `Send patch to Nostr (NIP-34)`,
      relays,
    );

    console.log(
      `[ngit-api] Patch published: ${signedEvent.id.slice(0, 12)}… → ${publishResult.successes}/${relays.length} relays`,
    );

    return Response.json({
      eventId: signedEvent.id,
      kind: PATCH_KIND,
      relays: publishResult.results,
      successes: publishResult.successes,
      failures: publishResult.failures,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Signing or publishing failed";
    console.warn(`[ngit-api] Send patch failed: ${message}`);
    return jsonError(message, 502);
  }
}

/**
 * POST /api/ngit/create-pr
 *
 * Build a kind 1618 pull request event, sign via browser, publish to relays.
 */
async function handleCreatePR(
  deps: NgitApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;

  if (!sessionId) return jsonError("sessionId is required", 400);

  const repoReference = body.repo_reference as string | undefined;
  const earliestUniqueCommit = body.earliest_unique_commit as string | undefined;
  const repoOwnerPubkey = body.repo_owner_pubkey as string | undefined;
  const subject = body.subject as string | undefined;
  const description = body.description as string | undefined;
  const commitId = body.commit_id as string | undefined;
  const cloneUrls = body.clone_urls as string[] | undefined;

  if (!repoReference) return jsonError("repo_reference is required", 400);
  if (!earliestUniqueCommit) return jsonError("earliest_unique_commit is required", 400);
  if (!repoOwnerPubkey) return jsonError("repo_owner_pubkey is required", 400);
  if (!subject) return jsonError("subject is required", 400);
  if (!commitId) return jsonError("commit_id is required (branch tip commit)", 400);
  if (!cloneUrls || cloneUrls.length === 0) return jsonError("clone_urls is required (at least one)", 400);

  let validated: ValidatedSession;
  try {
    validated = validateSessionAndGrant(deps, sessionId);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return jsonError((err as Error).message, status);
  }

  const relays = resolveRelays(body, deps.defaultRelays);

  const input: PullRequestInput = {
    repoReference,
    earliestUniqueCommit,
    repoOwnerPubkey,
    description: description ?? "",
    subject,
    commitId,
    cloneUrls,
    branchName: body.branch_name as string | undefined,
    mergeBase: body.merge_base as string | undefined,
    labels: body.labels as string[] | undefined,
    replacesPatchId: body.replaces_patch_id as string | undefined,
    recipients: body.recipients as string[] | undefined,
  };

  const eventTemplate = buildPullRequest(input);

  try {
    const { signedEvent, publishResult } = await signAndPublish(
      eventTemplate,
      validated.npub,
      validated.grantId,
      `Create pull request "${subject}" on Nostr (NIP-34)`,
      relays,
    );

    console.log(
      `[ngit-api] PR published: "${subject}" → ${publishResult.successes}/${relays.length} relays`,
    );

    return Response.json({
      eventId: signedEvent.id,
      kind: PULL_REQUEST_KIND,
      subject,
      relays: publishResult.results,
      successes: publishResult.successes,
      failures: publishResult.failures,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Signing or publishing failed";
    console.warn(`[ngit-api] Create PR failed: ${message}`);
    return jsonError(message, 502);
  }
}

/**
 * POST /api/ngit/create-issue
 *
 * Build a kind 1621 issue event, sign via browser, publish to relays.
 */
async function handleCreateIssue(
  deps: NgitApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;

  if (!sessionId) return jsonError("sessionId is required", 400);

  const repoReference = body.repo_reference as string | undefined;
  const repoOwnerPubkey = body.repo_owner_pubkey as string | undefined;
  const content = body.content as string | undefined;

  if (!repoReference) return jsonError("repo_reference is required", 400);
  if (!repoOwnerPubkey) return jsonError("repo_owner_pubkey is required", 400);
  if (!content) return jsonError("content is required", 400);

  let validated: ValidatedSession;
  try {
    validated = validateSessionAndGrant(deps, sessionId);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return jsonError((err as Error).message, status);
  }

  const relays = resolveRelays(body, deps.defaultRelays);

  const input: IssueInput = {
    repoReference,
    repoOwnerPubkey,
    content,
    subject: body.subject as string | undefined,
    labels: body.labels as string[] | undefined,
  };

  const eventTemplate = buildIssue(input);
  const issueSubject = input.subject ?? "Untitled issue";

  try {
    const { signedEvent, publishResult } = await signAndPublish(
      eventTemplate,
      validated.npub,
      validated.grantId,
      `Create issue "${issueSubject}" on Nostr (NIP-34)`,
      relays,
    );

    console.log(
      `[ngit-api] Issue published: "${issueSubject}" → ${publishResult.successes}/${relays.length} relays`,
    );

    return Response.json({
      eventId: signedEvent.id,
      kind: ISSUE_KIND,
      subject: issueSubject,
      relays: publishResult.results,
      successes: publishResult.successes,
      failures: publishResult.failures,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Signing or publishing failed";
    console.warn(`[ngit-api] Create issue failed: ${message}`);
    return jsonError(message, 502);
  }
}

/**
 * POST /api/ngit/set-status
 *
 * Build a kind 1630-1633 status event, sign via browser, publish to relays.
 */
async function handleSetStatus(
  deps: NgitApiDependencies,
  request: Request,
): Promise<Response> {
  const body = await parseBody(request);
  const sessionId = body.sessionId as string | undefined;

  if (!sessionId) return jsonError("sessionId is required", 400);

  const targetEventId = body.target_event_id as string | undefined;
  const status = body.status as string | undefined;

  if (!targetEventId) return jsonError("target_event_id is required", 400);
  if (!status) return jsonError("status is required", 400);

  const validStatuses: StatusValue[] = ["open", "applied", "closed", "draft"];
  if (!validStatuses.includes(status as StatusValue)) {
    return jsonError(`status must be one of: ${validStatuses.join(", ")}`, 400);
  }

  let validated: ValidatedSession;
  try {
    validated = validateSessionAndGrant(deps, sessionId);
  } catch (err) {
    const errStatus = (err as { status?: number }).status ?? 500;
    return jsonError((err as Error).message, errStatus);
  }

  const relays = resolveRelays(body, deps.defaultRelays);

  const input: StatusInput = {
    targetEventId,
    status: status as StatusValue,
    content: body.content as string | undefined,
    repoReference: body.repo_reference as string | undefined,
    earliestUniqueCommit: body.earliest_unique_commit as string | undefined,
    repoOwnerPubkey: body.repo_owner_pubkey as string | undefined,
    targetAuthorPubkey: body.target_author_pubkey as string | undefined,
    acceptedRevisionId: body.accepted_revision_id as string | undefined,
    mergeCommit: body.merge_commit as string | undefined,
    appliedAsCommits: body.applied_as_commits as string[] | undefined,
    appliedPatchIds: body.applied_patch_ids as StatusInput["appliedPatchIds"],
  };

  const eventTemplate = buildStatus(input);

  try {
    const { signedEvent, publishResult } = await signAndPublish(
      eventTemplate,
      validated.npub,
      validated.grantId,
      `Set status to "${status}" on Nostr (NIP-34)`,
      relays,
    );

    console.log(
      `[ngit-api] Status published: ${status} for ${targetEventId.slice(0, 12)}… → ${publishResult.successes}/${relays.length} relays`,
    );

    return Response.json({
      eventId: signedEvent.id,
      kind: eventTemplate.kind,
      status,
      targetEventId,
      relays: publishResult.results,
      successes: publishResult.successes,
      failures: publishResult.failures,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Signing or publishing failed";
    console.warn(`[ngit-api] Set status failed: ${message}`);
    return jsonError(message, 502);
  }
}

/**
 * GET /api/ngit/proposals?sessionId=...&repo_reference=...
 *
 * Query relays for patches (1617), PRs (1618), and issues (1621) on a repo.
 */
async function handleListProposals(
  deps: NgitApiDependencies,
  url: URL,
): Promise<Response> {
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) return jsonError("sessionId query parameter is required", 400);

  const session = deps.getSession(sessionId);
  if (!session) return jsonError("Unknown session", 404);

  const repoReference = url.searchParams.get("repo_reference");
  if (!repoReference) {
    return jsonError("repo_reference query parameter is required (format: 30617:<pubkey>:<identifier>)", 400);
  }

  const relayParam = url.searchParams.get("relays");
  const relays = relayParam
    ? relayParam.split(",").map((r) => r.trim()).filter(Boolean)
    : deps.defaultRelays;

  const kindsParam = url.searchParams.get("kinds");
  const kinds = kindsParam
    ? kindsParam.split(",").map((k) => Number(k.trim())).filter((k) => !isNaN(k))
    : [PATCH_KIND, PULL_REQUEST_KIND, ISSUE_KIND];

  try {
    const events = await queryRelays(relays, {
      kinds,
      "#a": [repoReference],
      limit: 100,
    } as Parameters<typeof queryRelays>[1]);

    const proposals = events.map((e) => {
      const kindLabel =
        e.kind === PATCH_KIND ? "patch" :
        e.kind === PULL_REQUEST_KIND ? "pull_request" :
        e.kind === ISSUE_KIND ? "issue" : `kind_${e.kind}`;

      return {
        eventId: e.id,
        kind: e.kind,
        type: kindLabel,
        subject: e.tags.find((t) => t[0] === "subject")?.[1],
        content: e.content.slice(0, 500) + (e.content.length > 500 ? "…" : ""),
        pubkey: e.pubkey,
        createdAt: e.created_at,
        commitId: e.tags.find((t) => t[0] === "c" || t[0] === "commit")?.[1],
        branchName: e.tags.find((t) => t[0] === "branch-name")?.[1],
        labels: e.tags.filter((t) => t[0] === "t").map((t) => t[1]),
        isRoot: e.tags.some((t) => t[0] === "t" && t[1] === "root"),
      };
    });

    return Response.json({ proposals, count: proposals.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Relay query failed";
    console.warn(`[ngit-api] List proposals failed: ${message}`);
    return jsonError(message, 502);
  }
}

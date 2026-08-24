/**
 * API route handlers for session and archive endpoints.
 * Extracted from server.ts to reduce file size.
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { normalize, join } from "node:path";
import type { AgentType } from "../config";
import type { ProcessManager, SessionOrigin, SessionSnapshot } from "../agents/process-manager";
import type { RequestAuthContext } from "../auth/request-context";
import type { AccessAction } from "../auth/access-control";
import type { WorkspaceScope } from "../workspaces/workspace-scope";
import { normaliseNpub, deriveNpubSegment } from "../identity/npub-utils";
import { generateIdentityAlias } from "../identity/identity-alias";
import { validateInput, ArchiveListOptionsSchema } from "../utils/validation";
import type { messageStore as MessageStoreInstance, StoredMessage, StoredSessionRecord } from "../storage/message-store";
import type {
  ArchiveListOptions,
  ArchiveSessionCategory,
  ArchivedSession,
  sessionArchiveStore as SessionArchiveStoreInstance,
} from "../storage/session-archive-store";
import type { ForkToWorktreeInput } from "../sessions/fork-to-worktree";
import { resolveSessionOwnerNpub } from "../sessions/session-ownership";
import {
  NativeResumeLaunchError,
  resolveNativeResumeLaunch,
  type NativeResumeSourceSession,
} from "../sessions/native-resume-launch";
import { deliverSessionAgentMessage } from "./session-agent-message";
import { normalizeBusySessionMessageFailure } from "./session-message-failures";
import {
  retainBusyDirectAdapterPrompt,
  retainDirectAdapterPrompt,
} from "./session-message-retention";
import { generateSpeechAudio, normalizeSpeechText as normalizeSharedSpeechText, resolveSpeechExtension } from "./audio-speech";
import { generateSpeechSummary } from "./speech-summary";
import type { PromptReadiness } from "../agents/agent-adapter";
import { createNativeAgentSessionMetadata } from "../agents/native-session";
import type { CodexSessionForkInput, CodexSessionForkResult } from "../agents/codex-session-fork";
import { readCodexSessionMessagesFromFile } from "../agents/codex-session-messages";
import {
  isAgentManagedByMetadataOrOrigin,
  normaliseSessionMetadata,
  resolveSessionChargeNpub,
  type SessionMetadata,
} from "../sessions/session-metadata";
import {
  buildDelegatedWorkspaceScope,
  createOwnerScopedAuthContext,
  DelegationScopes,
  getDelegatedBillingNpub,
  resolveOwnerAccess,
} from "../auth/delegation-access";
import type { WorkspaceDelegationStore } from "../storage/workspace-delegation-store";
import type { NightWatchStartOptions } from "../nightwatch/nightwatch-start-config";
import { closeStaleStableAutoSessions } from "../sessions/bulk-close-auto-sessions";
import type { DocumentDirectStore } from "../agent-chat/document-direct-runtime";
import { resolveSessionTargetFile, resolveStoredSessionTargetFile } from "../security/filesystem-boundary";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";
const MAX_SPEECH_TEXT_LENGTH = 4_000;
const DEFAULT_SETTINGS_SPEECH_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_SETTINGS_SPEECH_MODEL = "hexgrad/kokoro-82m";
const DEFAULT_SETTINGS_SPEECH_VOICE = "af_heart";
const DEFAULT_SETTINGS_SPEECH_FORMAT = "mp3";
const DEFAULT_SETTINGS_SPEECH_SUMMARY_MODEL = "openai/gpt-4o-mini";
const DEFAULT_LOCAL_SPEECH_BASE_URL = "http://127.0.0.1:8880/v1";
const DEFAULT_LOCAL_SPEECH_MODEL = "kokoro";
const DEFAULT_LOCAL_SPEECH_VOICE = "am_onyx";
const DEFAULT_LOCAL_SPEECH_SUMMARY_BASE_URL = "http://127.0.0.1:11434/v1";
const DEFAULT_LOCAL_SPEECH_SUMMARY_MODEL = "gemma4:e4b";

// ---------- Types shared with server.ts ----------

type SessionWorkspaceRequest =
  | { mode: "worktree"; name: string }
  | null;

export type IdentitySummary = {
  npub: string | null;
  normalizedNpub: string | null;
  segment: string;
  alias: string;
  ports: number[];
  sessionIds: string[];
  activeSessionIds: string[];
  lastSeenAt: string | null;
  dataRoot: string;
  logsRoot: string;
  attachmentsRoot: string;
  imagesRoot: string;
};

// ---------- Context supplied by server.ts ----------

export interface SessionApiContext {
  manager: ProcessManager;
  adminNpub: string | null;
  adminNpubs?: string[];
  isAdminNpub?: (npub: string | null | undefined) => boolean;
  agentHost: string;

  // Stores
  messageStore: typeof MessageStoreInstance;
  sessionArchiveStore: typeof SessionArchiveStoreInstance;
  identityUserStore: {
    touch: (npub: string) => unknown;
    listUsers: () => Array<{ normalizedNpub: string; ports: number[] }>;
    ensurePortsFor: (npub: string) => number[];
    getByNormalized: (normalizedNpub: string) => { ports?: number[] } | null;
  };
  promptQueueStore: {
    getSessionQueue: (id: string) => unknown[];
    addPrompt: (id: string, options: { content: string }) => unknown;
    updatePromptContent: (sessionId: string, promptId: string, content: string) => boolean;
    deletePromptById: (sessionId: string, promptId: string) => boolean;
    getNextQueuedPrompt: (sessionId: string) => { content: string } | null;
    removeNextPrompt: (sessionId: string) => void;
    getQueueCount: (sessionId: string) => number;
  };
  artifactsStore: {
    listBySession: (sessionId: string) => unknown[];
  };
  userSettingsStore?: {
    getAll: (npub: string) => Record<string, string>;
  };

  // Directory paths
  userIdentityRoot: string;
  attachmentRoot: string;
  imageRoot: string;

  // Auth helpers
  ensureApiAccess: (action: AccessAction, request: Request, url: URL, authContext: RequestAuthContext) => Promise<Response | null>;
  resolveWorkspace: (context?: RequestAuthContext) => WorkspaceScope;

  // Session helpers
  serializeSession: (session: SessionSnapshot) => Record<string, unknown>;
  sessionBelongsToViewer: (
    sessionNpub: string | null | undefined,
    sessionMetadata: SessionMetadata | null | undefined,
    viewerNormalizedNpub: string | null,
    viewerIsAdmin: boolean,
  ) => boolean;
  getViewerNormalizedNpub: (authContext: RequestAuthContext) => string | null;
  buildIdentitySummaries: (sessions: SessionSnapshot[], viewerNpub: string | null, options?: { includeAll?: boolean }) => IdentitySummary[];
  createSessionSubscribeResponse: (npub: string) => Response;
  handleSessionEvents: (sessionId: string, request: Request) => Response | Promise<Response>;
  syncSessionMessages: (sessionId: string, force?: boolean) => Promise<unknown[]>;
  waitForMessageUpdate: (sessionId: string, initialCount: number, timeoutMs?: number) => Promise<unknown[]>;
  scheduleSessionArchive: (sessionId: string, manager: ProcessManager) => void;
  cancelPendingArchive: (sessionId: string) => void;

  // Agent helpers
  isAgentType: (value: string) => value is AgentType;
  normaliseSessionNameInput: (value: unknown) => string | null;
  parseSessionWorkspaceRequest: (input: unknown) => SessionWorkspaceRequest;
  resolveSessionWorkingDirectory: (
    directoryInput: string | undefined,
    workspace: SessionWorkspaceRequest,
    workspaceScopeOverride?: WorkspaceScope,
  ) => Promise<string>;
  parseSessionOriginInput: (value: unknown) => SessionOrigin | null;
  parseNightWatchStartOptions: (value: unknown) => NightWatchStartOptions | null;
  buildAgentUrl: (host: string, port: number, path: string) => string | URL;
  enableNightWatch: (sessionId: string, options?: Omit<NightWatchStartOptions, "enabled">) => unknown;

  // Queue helpers
  queueDispatchInFlight: Set<string>;
  maybeAutoDispatchQueuedPrompt: (session: SessionSnapshot | null) => void;
  dispatchNextQueuedPromptForSession: (session: SessionSnapshot, userNpub: string | null) => Promise<Record<string, unknown>>;
  getPromptReadinessForSession?: (session: SessionSnapshot) => Promise<PromptReadiness>;

  // Fork-to-worktree helpers
  validateForkInput: (payload: unknown) => ForkToWorktreeInput;
  getRecentMessages: (messageStore: typeof MessageStoreInstance, sessionId: string, count?: number) => StoredMessage[];
  formatMessagesAsContext: (messages: StoredMessage[]) => string;
  createGitWorktree: (options: { directory: string; branch: string; startPoint: string | null }) => Promise<{ path: string }>;
  forkCodexSession: (input: CodexSessionForkInput) => Promise<CodexSessionForkResult>;
  workspaceDelegationStore: WorkspaceDelegationStore;

  // Access action
  AccessActions: { SessionsManage: AccessAction; SessionsRead: AccessAction };
  documentDirectStore?: DocumentDirectStore;
  canViewDocumentSubscription?: (subscriptionId: string, viewerNpub: string) => boolean;
  resolveDocumentSessionStatus?: (sessionId: string | null) => string;
}

const sessionAccessAction = (ctx: SessionApiContext, method: HttpMethod): AccessAction =>
  method === "GET" || method === "HEAD" ? ctx.AccessActions.SessionsRead : ctx.AccessActions.SessionsManage;

const isConfiguredAdminNpub = (ctx: SessionApiContext, npub: string | null | undefined): boolean => {
  if (ctx.isAdminNpub) {
    return ctx.isAdminNpub(npub);
  }
  const normalized = normaliseNpub(npub);
  return Boolean(ctx.adminNpub && normalized && ctx.adminNpub === normalized);
};

const isDelegatedBotAuth = (authContext: RequestAuthContext): boolean => {
  return Boolean(
    authContext.authMethod === "nip98" &&
    authContext.delegatedByBot &&
    normaliseNpub(authContext.subjectNpub ?? authContext.npub ?? null) &&
    normaliseNpub(authContext.delegatedOwnerNpub ?? null),
  );
};

const isProgrammaticCaller = (authContext: RequestAuthContext): boolean => {
  return authContext.authMethod === "nip98" && !!authContext.npub;
};

const isAuthorizedCaller = (authContext: RequestAuthContext): boolean => {
  if (authContext.session) return true;
  if (isProgrammaticCaller(authContext)) return true;
  return false;
};

const buildProgrammaticOrigin = (authContext: RequestAuthContext): SessionOrigin => {
  if (authContext.delegatedByBot) {
    const actorNpub = normaliseNpub(authContext.actorNpub ?? null) ?? "unknown-bot";
    return { type: "delegate-bot", id: actorNpub, label: actorNpub };
  }
  const callerNpub = normaliseNpub(authContext.npub ?? null) ?? "unknown-cli";
  return { type: "cli", id: callerNpub, label: callerNpub };
};

const resolveSelfSpaceViewerNpub = (
  authContext: RequestAuthContext,
  ctx: SessionApiContext,
): string | null => {
  if (isDelegatedBotAuth(authContext)) {
    return normaliseNpub(authContext.delegatedOwnerNpub ?? null);
  }
  return ctx.getViewerNormalizedNpub(authContext);
};

const recordLiveSession = async (
  ctx: SessionApiContext,
  session: SessionSnapshot,
): Promise<void> => {
  persistLiveSessionRecord(ctx, session);
  await ctx.syncSessionMessages(session.id, true);
};

const persistLiveSessionRecord = (
  ctx: SessionApiContext,
  session: SessionSnapshot,
): void => {
  ctx.messageStore.recordSession({
    id: session.id,
    agent: session.agent,
    startedAt: session.startedAt,
    name: session.name,
    npub: session.npub,
    port: session.port,
    pid: session.pid,
    workingDirectory: session.workingDirectory,
    command: session.command,
    runtimeStatus: session.agentRuntimeStatus ?? null,
    origin: session.origin ?? null,
    pm2Name: session.pm2Name,
    tmuxSession: session.tmuxSession,
    tmuxWindow: session.tmuxWindow,
    targetFile: session.targetFile,
    tabOrder: session.tabOrder ?? null,
    metadata: session.metadata,
  });
};

async function createNativeResumeSession(
  source: NativeResumeSourceSession,
  authContext: RequestAuthContext,
  ctx: SessionApiContext,
): Promise<Response> {
  let launch;
  try {
    launch = resolveNativeResumeLaunch(
      source,
      ctx.isAgentType,
      authContext.subjectNpub ?? authContext.npub,
    );
  } catch (error) {
    if (error instanceof NativeResumeLaunchError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
  const session = await ctx.manager.createSession(
    launch.agent,
    launch.workingDirectory,
    launch.name,
    launch.origin,
    undefined,
    launch.ownerNpub,
    launch.metadata,
  );
  await recordLiveSession(ctx, session);
  return Response.json({
    session: ctx.serializeSession(session),
    resumedFromWingmanSessionId: source.id,
    nativeAgentSession: session.metadata?.nativeAgentSession ?? null,
  }, { status: 201 });
}

const resolveOwnedLiveSession = (
  requestedId: string,
  sessions: SessionSnapshot[],
  viewerNormalizedNpub: string | null,
  viewerIsAdmin: boolean,
  ctx: SessionApiContext,
): { session: SessionSnapshot | null; resolvedId: string; error: Response | null } => {
  const ownedSessions = sessions.filter((session) =>
    ctx.sessionBelongsToViewer(session.npub ?? null, session.metadata, viewerNormalizedNpub, viewerIsAdmin),
  );
  const exactMatch = ownedSessions.find((session) => session.id === requestedId);
  if (exactMatch) {
    return { session: exactMatch, resolvedId: exactMatch.id, error: null };
  }

  // SECURITY: Only allow prefix matching for reasonably long prefixes to prevent session contamination
  // Prefix must be at least 8 characters to avoid accidental matches between similar session IDs
  if (requestedId.length >= 8) {
    const prefixMatches = ownedSessions.filter((session) => session.id.startsWith(requestedId));
    if (prefixMatches.length === 1) {
      const match = prefixMatches[0]!;
      console.log(`[Session Resolution] Prefix match: ${requestedId} -> ${match.id}`);
      return { session: match, resolvedId: match.id, error: null };
    }

    if (prefixMatches.length > 1) {
      console.warn(`[Session Resolution] Ambiguous prefix: ${requestedId}, matches: ${prefixMatches.map(s => s.id).join(', ')}`);
      return {
        session: null,
        resolvedId: requestedId,
        error: Response.json(
          {
            error: "Ambiguous session id",
            matches: prefixMatches.map((session) => ({
              id: session.id,
              name: session.name ?? null,
            })),
          },
          { status: 409 },
        ),
      };
    }
  } else {
    console.warn(`[Session Resolution] Prefix too short for matching: ${requestedId} (length: ${requestedId.length})`);
  }

  return { session: null, resolvedId: requestedId, error: null };
};

const resolveOwnedStoredSession = (
  requestedId: string,
  viewerNormalizedNpub: string | null,
  viewerIsAdmin: boolean,
  ctx: SessionApiContext,
) => {
  const ownedSessions = ctx.messageStore
    .listSessions()
    .filter((session) => ctx.sessionBelongsToViewer(session.npub ?? null, session.metadata, viewerNormalizedNpub, viewerIsAdmin));
  const exactMatch = ownedSessions.find((session) => session.id === requestedId);
  if (exactMatch) {
    return { session: exactMatch, resolvedId: exactMatch.id, error: null };
  }

  // SECURITY: Only allow prefix matching for reasonably long prefixes to prevent session contamination
  // Prefix must be at least 8 characters to avoid accidental matches between similar session IDs
  if (requestedId.length >= 8) {
    const prefixMatches = ownedSessions.filter((session) => session.id.startsWith(requestedId));
    if (prefixMatches.length === 1) {
      const match = prefixMatches[0]!;
      console.log(`[Stored Session Resolution] Prefix match: ${requestedId} -> ${match.id}`);
      return { session: match, resolvedId: match.id, error: null };
    }

    if (prefixMatches.length > 1) {
      console.warn(`[Stored Session Resolution] Ambiguous prefix: ${requestedId}, matches: ${prefixMatches.map(s => s.id).join(', ')}`);
      return {
        session: null,
        resolvedId: requestedId,
        error: Response.json(
          {
            error: "Ambiguous session id",
            matches: prefixMatches.map((session) => ({
              id: session.id,
              name: session.name ?? null,
            })),
          },
          { status: 409 },
        ),
      };
    }
  } else {
    console.warn(`[Stored Session Resolution] Prefix too short for matching: ${requestedId} (length: ${requestedId.length})`);
  }

  return { session: null, resolvedId: requestedId, error: null };
};

const archivedSessionBelongsToViewer = (
  archivedSession: ArchivedSession,
  viewerNormalizedNpub: string | null,
  viewerIsAdmin: boolean,
  ctx: SessionApiContext,
): boolean => {
  return ctx.sessionBelongsToViewer(
    archivedSession.npub,
    archivedSession.metadata,
    viewerNormalizedNpub,
    viewerIsAdmin,
  );
};

const resolveOwnedArchivedSession = (
  requestedId: string,
  viewerNormalizedNpub: string | null,
  viewerIsAdmin: boolean,
  ctx: SessionApiContext,
) => {
  const exactMatch = ctx.sessionArchiveStore.getArchivedSession(requestedId);
  if (exactMatch && archivedSessionBelongsToViewer(exactMatch, viewerNormalizedNpub, viewerIsAdmin, ctx)) {
    return { session: exactMatch, resolvedId: exactMatch.id, error: null };
  }

  // SECURITY: Only allow prefix matching for reasonably long prefixes to prevent session contamination
  // Prefix must be at least 8 characters to avoid accidental matches between similar session IDs
  if (requestedId.length >= 8) {
    const archiveCount = ctx.sessionArchiveStore.getArchiveCount();
    const ownedSessions = ctx.sessionArchiveStore
      .listArchivedSessions({ limit: archiveCount, offset: 0 })
      .filter((session) => archivedSessionBelongsToViewer(session, viewerNormalizedNpub, viewerIsAdmin, ctx));
    const prefixMatches = ownedSessions.filter((session) => session.id.startsWith(requestedId));
    if (prefixMatches.length === 1) {
      const match = prefixMatches[0]!;
      console.log(`[Archived Session Resolution] Prefix match: ${requestedId} -> ${match.id}`);
      return { session: match, resolvedId: match.id, error: null };
    }

    if (prefixMatches.length > 1) {
      console.warn(`[Archived Session Resolution] Ambiguous prefix: ${requestedId}, matches: ${prefixMatches.map(s => s.id).join(', ')}`);
      return {
        session: null,
        resolvedId: requestedId,
        error: Response.json(
          {
            error: "Ambiguous session id",
            matches: prefixMatches.map((session) => ({
              id: session.id,
              name: session.name ?? null,
            })),
          },
          { status: 409 },
        ),
      };
    }
  } else {
    console.warn(`[Archived Session Resolution] Prefix too short for matching: ${requestedId} (length: ${requestedId.length})`);
  }

  return { session: null, resolvedId: requestedId, error: null };
};

const parseSessionMetadataUpdateInput = (payload: unknown) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const candidate =
    record.metadata !== undefined
      ? record.metadata
      : record;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  const metadataPatch = candidate as Record<string, unknown>;
  return Object.keys(metadataPatch).length > 0 ? metadataPatch : null;
};

const buildSessionMetadataResponse = (
  sessionId: string,
  metadata: SessionMetadata | null | undefined,
  ownerNpub?: string,
) => {
  const payload: Record<string, unknown> = {
    id: sessionId,
    metadata: metadata ?? null,
  };
  if (ownerNpub) {
    payload.ownerNpub = ownerNpub;
  }
  return payload;
};

const persistStoredSessionMetadata = (
  ctx: SessionApiContext,
  storedSession: StoredSessionRecord,
  metadataPatch: Record<string, unknown>,
): SessionMetadata => {
  const mergedMetadata = normaliseSessionMetadata({
    ...(storedSession.metadata ?? {}),
    ...metadataPatch,
  });
  const parsedCommand = storedSession.command
    ? (() => {
        try {
          const parsed = JSON.parse(storedSession.command);
          return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")
            ? parsed as string[]
            : undefined;
        } catch {
          return undefined;
        }
      })()
    : undefined;

  ctx.messageStore.recordSession({
    id: storedSession.id,
    agent: storedSession.agent,
    startedAt: storedSession.startedAt,
    name: storedSession.name ?? undefined,
    npub: storedSession.npub ?? undefined,
    port: storedSession.port ?? undefined,
    pid: storedSession.pid ?? undefined,
    pm2Name: storedSession.pm2Name ?? undefined,
    tmuxSession: storedSession.tmuxSession ?? undefined,
    tmuxWindow: storedSession.tmuxWindow ?? undefined,
    logsDir: storedSession.logsDir ?? undefined,
    workingDirectory: storedSession.workingDirectory ?? undefined,
    command: parsedCommand,
    runtimeStatus: storedSession.runtimeStatus ?? null,
    origin: storedSession.origin ?? null,
    model: storedSession.model ?? undefined,
    targetFile: storedSession.targetFile ?? undefined,
    tabOrder: storedSession.tabOrder ?? null,
    metadata: mergedMetadata,
  });

  return mergedMetadata;
};

const parseStoredCommand = (storedCommand: string | null): string[] | undefined => {
  if (!storedCommand) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(storedCommand);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")
      ? parsed as string[]
      : undefined;
  } catch {
    return undefined;
  }
};

const serializeStoredSession = (
  storedSession: StoredSessionRecord,
): Record<string, unknown> => {
  const ownerNpub = resolveSessionOwnerNpub(storedSession.npub, storedSession.metadata);
  const serialized: Record<string, unknown> = {
    id: storedSession.id,
    agent: storedSession.agent,
    status: storedSession.runtimeStatus ?? "running",
    name: storedSession.name,
    npub: storedSession.npub,
    ownerNpub,
    identityAlias: generateIdentityAlias(ownerNpub),
    port: storedSession.port,
    pid: storedSession.pid,
    startedAt: storedSession.startedAt,
    lastUpdatedAt: storedSession.lastUpdatedAt,
    command: parseStoredCommand(storedSession.command) ?? [],
    workingDirectory: storedSession.workingDirectory,
    origin: storedSession.origin,
    model: storedSession.model,
    targetFile: storedSession.targetFile,
    tabOrder: storedSession.tabOrder ?? null,
    metadata: storedSession.metadata,
  };
  if (storedSession.pm2Name) {
    serialized.pm2Name = storedSession.pm2Name;
  }
  if (storedSession.tmuxSession) {
    serialized.tmuxSession = storedSession.tmuxSession;
  }
  if (storedSession.tmuxWindow) {
    serialized.tmuxWindow = storedSession.tmuxWindow;
  }
  return serialized;
};

const getSessionSortStartedAt = (session: Pick<SessionSnapshot | StoredSessionRecord, "startedAt">): number => {
  const time = Date.parse(session.startedAt ?? "");
  return Number.isFinite(time) ? time : 0;
};

type SessionTabOrderCandidate = {
  id: string;
  startedAt: string;
  tabOrder?: number | null;
};

const getSessionSortOrder = (
  session: SessionTabOrderCandidate,
): number => {
  return typeof session.tabOrder === "number" && Number.isFinite(session.tabOrder)
    ? session.tabOrder
    : Number.MAX_SAFE_INTEGER;
};

const compareSessionsForTabs = (
  a: SessionTabOrderCandidate,
  b: SessionTabOrderCandidate,
): number => {
  const byOrder = getSessionSortOrder(a) - getSessionSortOrder(b);
  if (byOrder !== 0) return byOrder;
  const byStarted = getSessionSortStartedAt(a) - getSessionSortStartedAt(b);
  if (byStarted !== 0) return byStarted;
  return String(a.id).localeCompare(String(b.id));
};

const parseSessionPositionInput = (value: unknown): number | null | undefined => {
  if (value === undefined) return undefined;
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : NaN;
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const position = Math.floor(numeric);
  return position >= 1 ? position : null;
};

const reorderLiveSessionTabs = async (
  ctx: SessionApiContext,
  sessions: SessionSnapshot[],
  sessionId: string,
  requestedPosition: number,
): Promise<SessionSnapshot | null> => {
  const orderedSessions = [...sessions].sort(compareSessionsForTabs);
  const currentIndex = orderedSessions.findIndex((session) => session.id === sessionId);
  if (currentIndex < 0) {
    return null;
  }

  const [movingSession] = orderedSessions.splice(currentIndex, 1);
  if (!movingSession) {
    return null;
  }
  const nextIndex = Math.min(Math.max(requestedPosition - 1, 0), orderedSessions.length);
  orderedSessions.splice(nextIndex, 0, movingSession);

  let updatedTarget: SessionSnapshot | null = null;
  for (let index = 0; index < orderedSessions.length; index += 1) {
    const session = orderedSessions[index];
    if (!session) continue;
    const updated = ctx.manager.updateSessionTabOrder(session.id, index + 1);
    if (updated) {
      persistLiveSessionRecord(ctx, ctx.manager.getSession(session.id) ?? updated);
      if (session.id === sessionId) {
        updatedTarget = ctx.manager.getSession(session.id) ?? updated;
      }
    }
  }
  return updatedTarget;
};

const rehydrateStoredSession = async (
  ctx: SessionApiContext,
  storedSession: StoredSessionRecord | null,
): Promise<SessionSnapshot | null> => {
  if (!storedSession) {
    return null;
  }
  if (!storedSession.port || !storedSession.workingDirectory || !ctx.isAgentType(storedSession.agent)) {
    return null;
  }
  if (typeof ctx.manager.rehydrateSession !== "function") {
    return null;
  }

  let targetFile: string | undefined;
  try {
    targetFile = await resolveStoredSessionTargetFile(storedSession.workingDirectory, storedSession.targetFile);
  } catch {
    return null;
  }
  return ctx.manager.rehydrateSession({
    id: storedSession.id,
    agent: storedSession.agent,
    port: storedSession.port,
    name: storedSession.name ?? storedSession.id,
    startedAt: storedSession.startedAt,
    workingDirectory: storedSession.workingDirectory,
    command: parseStoredCommand(storedSession.command),
    pid: storedSession.pid ?? undefined,
    npub: storedSession.npub ?? undefined,
    agentRuntimeStatus: storedSession.runtimeStatus ?? null,
    origin: storedSession.origin ?? null,
    pm2Name: storedSession.pm2Name ?? undefined,
    tmuxSession: storedSession.tmuxSession ?? undefined,
    tmuxWindow: storedSession.tmuxWindow ?? undefined,
    targetFile,
    model: storedSession.model ?? undefined,
    metadata: storedSession.metadata,
  });
};

type OwnerSessionRouteMatch = {
  ownerNpub: string;
  remainder: string[];
};

type OwnerArchiveRouteMatch = {
  ownerNpub: string;
  remainder: string[];
};

const matchOwnerSessionRoute = (pathname: string): OwnerSessionRouteMatch | null => {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[0] !== "api" || parts[1] !== "owners") {
    return null;
  }
  const ownerNpub = normaliseNpub(parts[2] ?? null);
  if (!ownerNpub || parts[3] !== "sessions") {
    return null;
  }
  return {
    ownerNpub,
    remainder: parts.slice(4),
  };
};

const matchOwnerArchiveRoute = (pathname: string): OwnerArchiveRouteMatch | null => {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[0] !== "api" || parts[1] !== "owners") {
    return null;
  }
  const ownerNpub = normaliseNpub(parts[2] ?? null);
  if (!ownerNpub || parts[3] !== "archive") {
    return null;
  }
  return {
    ownerNpub,
    remainder: parts.slice(4),
  };
};

const buildManagedSessionMetadata = (
  authContext: RequestAuthContext,
  ownerNpub: string,
  chargeToNpub: string | null,
  delegateRelationshipId?: string | null,
  existingMetadata?: Record<string, unknown> | null,
) => ({
  ...(existingMetadata ?? {}),
  ownerNpub,
  createdByNpub: authContext.subjectNpub ?? authContext.npub ?? undefined,
  lastManagedByNpub: authContext.subjectNpub ?? authContext.npub ?? undefined,
  chargeToNpub: chargeToNpub ?? undefined,
  delegateRelationshipId: delegateRelationshipId ?? undefined,
});

const resolveOwnerSessionAccess = (
  authContext: RequestAuthContext,
  ownerNpub: string,
  scope: string,
  ctx: SessionApiContext,
) =>
  resolveOwnerAccess(
    authContext,
    ownerNpub,
    ctx.workspaceDelegationStore.findActiveDelegation.bind(ctx.workspaceDelegationStore),
    scope,
  );

const resolveOwnerSessionScope = (method: HttpMethod, remainder: string[]): string => {
  if (remainder.length === 0) {
    return method === "POST" ? DelegationScopes.SessionsCreate : DelegationScopes.SessionsRead;
  }
  const subresource = remainder[1];
  if (!subresource) {
    return method === "GET" || method === "HEAD" ? DelegationScopes.SessionsRead : DelegationScopes.SessionsManage;
  }
  if (subresource === "messages") {
    return method === "POST" ? DelegationScopes.SessionsMessage : DelegationScopes.SessionsRead;
  }
  if (subresource === "metadata") {
    return method === "GET" || method === "HEAD" ? DelegationScopes.SessionsRead : DelegationScopes.SessionsManage;
  }
  if (subresource === "history" || subresource === "events") {
    return DelegationScopes.SessionsRead;
  }
  return DelegationScopes.SessionsManage;
};

const archivedSessionBelongsToOwner = (
  archivedSession: { npub: string | null; metadata?: SessionMetadata | null },
  ownerNpub: string,
  ctx: SessionApiContext,
): boolean => {
  const metadataOwnerNpub =
    archivedSession.metadata &&
    typeof archivedSession.metadata === "object" &&
    typeof archivedSession.metadata.ownerNpub === "string"
      ? normaliseNpub(archivedSession.metadata.ownerNpub)
      : null;
  if (metadataOwnerNpub) {
    return metadataOwnerNpub === ownerNpub;
  }
  return ctx.sessionBelongsToViewer(archivedSession.npub, archivedSession.metadata ?? null, ownerNpub, false);
};

const resolveArchiveCategory = (category: unknown): ArchiveSessionCategory | undefined =>
  category === "my" || category === "auto" ? category : undefined;

const buildArchiveFilterOptions = (
  validatedOptions: { filter?: unknown; since?: unknown },
): Pick<ArchiveListOptions, "filter" | "since"> => ({
  filter: typeof validatedOptions.filter === "string" ? validatedOptions.filter : undefined,
  since: typeof validatedOptions.since === "string" ? validatedOptions.since : undefined,
});

const countArchivedSessionsByCategory = (
  ctx: SessionApiContext,
  options: Pick<ArchiveListOptions, "filter" | "since">,
) => ({
  my: ctx.sessionArchiveStore.getArchiveCount({ ...options, category: "my" }),
  auto: ctx.sessionArchiveStore.getArchiveCount({ ...options, category: "auto" }),
});

const listOwnedArchivedSessions = (
  ctx: SessionApiContext,
  ownerNpub: string,
  options: Pick<ArchiveListOptions, "filter" | "since" | "category">,
): ArchivedSession[] => {
  const archiveCount = ctx.sessionArchiveStore.getArchiveCount(options);
  return ctx.sessionArchiveStore
    .listArchivedSessions({ limit: archiveCount, offset: 0, ...options })
    .filter((session) => archivedSessionBelongsToOwner(session, ownerNpub, ctx));
};

const countOwnedArchivedSessionsByCategory = (
  ctx: SessionApiContext,
  ownerNpub: string,
  options: Pick<ArchiveListOptions, "filter" | "since">,
) => ({
  my: listOwnedArchivedSessions(ctx, ownerNpub, { ...options, category: "my" }).length,
  auto: listOwnedArchivedSessions(ctx, ownerNpub, { ...options, category: "auto" }).length,
});

/**
 * Main handler for /api/sessions/* and /api/archive/* routes.
 * Returns null if the route doesn't match, otherwise returns a Response.
 */
export async function handleSessionApi(
  request: Request,
  url: URL,
  method: HttpMethod,
  authContext: RequestAuthContext,
  ctx: SessionApiContext,
): Promise<Response | null> {
  const pathname = url.pathname;

  const documentBindingMatch = pathname.match(/^\/api\/document-bindings\/([^/]+)\/([^/]+)\/sessions$/);
  if (documentBindingMatch && method === "GET") {
    const denied = await ctx.ensureApiAccess(ctx.AccessActions.SessionsRead, request, url, authContext);
    if (denied) return denied;
    const viewerNpub = ctx.getViewerNormalizedNpub(authContext);
    if (!viewerNpub || !ctx.documentDirectStore || !ctx.canViewDocumentSubscription) {
      return Response.json({ error: "Document binding lookup is unavailable" }, { status: 403 });
    }
    const workspaceId = decodeURIComponent(documentBindingMatch[1]!);
    const documentId = decodeURIComponent(documentBindingMatch[2]!);
    const sessions = ctx.documentDirectStore.listBindings({ workspaceId, documentId })
      .filter((binding) => ctx.canViewDocumentSubscription!(binding.subscriptionId, viewerNpub))
      .map((binding) => ({ ...binding, status: ctx.resolveDocumentSessionStatus?.(binding.sessionId) ?? 'unknown' }));
    return Response.json({ workspaceId, documentId, sessions });
  }

  const ownerArchiveRoute = matchOwnerArchiveRoute(pathname);
  if (ownerArchiveRoute) {
    const requiredScope = method === "DELETE" ? DelegationScopes.SessionsManage : DelegationScopes.SessionsRead;
    const ownerArchiveAccess = resolveOwnerSessionAccess(
      authContext,
      ownerArchiveRoute.ownerNpub,
      requiredScope,
      ctx,
    );
    if (!ownerArchiveAccess) {
      return Response.json({ error: "Delegation required" }, { status: 403 });
    }
    const ownerArchiveAuthContext = createOwnerScopedAuthContext(
      authContext,
      ownerArchiveRoute.ownerNpub,
      ownerArchiveAccess,
      requiredScope,
    );
    const denied = await ctx.ensureApiAccess(sessionAccessAction(ctx, method), request, url, ownerArchiveAuthContext);
    if (denied) return denied;

    if (ownerArchiveRoute.remainder.length === 0 && method === "GET") {
      try {
        const validatedOptions = validateInput(ArchiveListOptionsSchema, {
          limit: url.searchParams.get("limit"),
          offset: url.searchParams.get("offset"),
          filter: url.searchParams.get("filter"),
          since: url.searchParams.get("since"),
          category: url.searchParams.get("category"),
        });
        const archiveFilterOptions = buildArchiveFilterOptions(validatedOptions);
        const category = resolveArchiveCategory(validatedOptions.category);
        const ownerArchivedSessions = listOwnedArchivedSessions(ctx, ownerArchiveRoute.ownerNpub, {
          ...archiveFilterOptions,
          category,
        });
        const ownerGroupCounts = countOwnedArchivedSessionsByCategory(
          ctx,
          ownerArchiveRoute.ownerNpub,
          archiveFilterOptions,
        );
        const offset = typeof validatedOptions.offset === "number" ? validatedOptions.offset : 0;
        const limit = typeof validatedOptions.limit === "number" ? validatedOptions.limit : 50;
        const archivedSessions = ownerArchivedSessions.slice(offset, offset + limit);
        return Response.json({
          ownerNpub: ownerArchiveRoute.ownerNpub,
          sessions: archivedSessions,
          total: ownerArchivedSessions.length,
          groupCounts: ownerGroupCounts,
          limit,
          offset,
        });
      } catch {
        return Response.json({ error: "Invalid request parameters" }, { status: 400 });
      }
    }

    const archiveId = ownerArchiveRoute.remainder[0];
    if (!archiveId) {
      return Response.json({ error: "Session ID required" }, { status: 400 });
    }
    const archivedSession = ctx.sessionArchiveStore.getArchivedSession(archiveId);
    if (!archivedSession || !archivedSessionBelongsToOwner(archivedSession, ownerArchiveRoute.ownerNpub, ctx)) {
      return Response.json({ error: "Archived session not found" }, { status: 404 });
    }

    if (ownerArchiveRoute.remainder[1] === "messages" && method === "GET") {
      const messages = ctx.sessionArchiveStore.getArchivedMessages(archiveId);
      return Response.json({ ownerNpub: ownerArchiveRoute.ownerNpub, sessionId: archiveId, messages });
    }

    if (ownerArchiveRoute.remainder.length === 1 && method === "GET") {
      const messages = ctx.sessionArchiveStore.getArchivedMessages(archiveId);
      return Response.json({ ownerNpub: ownerArchiveRoute.ownerNpub, session: archivedSession, messages });
    }

    if (ownerArchiveRoute.remainder[1] === "metadata" && method === "PATCH") {
      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
      }
      const metadataPatch = parseSessionMetadataUpdateInput(payload);
      if (!metadataPatch) {
        return Response.json({ error: "Invalid metadata payload" }, { status: 400 });
      }
      const updated = ctx.sessionArchiveStore.updateArchivedSessionMetadata(archiveId, {
        ...metadataPatch,
        lastManagedByNpub: authContext.subjectNpub ?? authContext.npub ?? undefined,
      });
      if (!updated) return Response.json({ error: "Archived session not found" }, { status: 404 });
      return Response.json(
        buildSessionMetadataResponse(archiveId, updated.metadata, ownerArchiveRoute.ownerNpub),
      );
    }

    if (ownerArchiveRoute.remainder.length === 1 && method === "DELETE") {
      const deleted = ctx.sessionArchiveStore.deleteArchivedSession(archiveId);
      if (!deleted) {
        return Response.json({ error: "Archived session not found" }, { status: 404 });
      }
      return Response.json({ ownerNpub: ownerArchiveRoute.ownerNpub, id: archiveId, deleted: true });
    }
  }

  // ──────────────────────────────────────────────
  //  Archive API endpoints
  // ──────────────────────────────────────────────

  if (pathname === "/api/archive" && method === "GET") {
    const denied = await ctx.ensureApiAccess(sessionAccessAction(ctx, method), request, url, authContext);
    if (denied) return denied;

    try {
      const validatedOptions = validateInput(ArchiveListOptionsSchema, {
        limit: url.searchParams.get("limit"),
        offset: url.searchParams.get("offset"),
        filter: url.searchParams.get("filter"),
        since: url.searchParams.get("since"),
        category: url.searchParams.get("category"),
      });

      const archiveFilterOptions = buildArchiveFilterOptions(validatedOptions);
      const category = resolveArchiveCategory(validatedOptions.category);
      const limit = typeof validatedOptions.limit === "number" ? validatedOptions.limit : undefined;
      const offset = typeof validatedOptions.offset === "number" ? validatedOptions.offset : undefined;
      const sessions = ctx.sessionArchiveStore.listArchivedSessions({
        limit,
        offset,
        ...archiveFilterOptions,
        category,
      });
      const total = ctx.sessionArchiveStore.getArchiveCount({
        ...archiveFilterOptions,
        category,
      });
      const groupCounts = countArchivedSessionsByCategory(ctx, archiveFilterOptions);
      return Response.json({ sessions, total, groupCounts, limit, offset });
    } catch (error) {
      return Response.json({ error: "Invalid request parameters" }, { status: 400 });
    }
  }

  if (pathname.startsWith("/api/archive/") && method === "GET") {
    const denied = await ctx.ensureApiAccess(sessionAccessAction(ctx, method), request, url, authContext);
    if (denied) return denied;

    const archiveParts = pathname.split("/").filter(Boolean);
    const sessionId = archiveParts[2];
    if (!sessionId) {
      return Response.json({ error: "Session ID required" }, { status: 400 });
    }

    // GET /api/archive/:id/messages
    if (archiveParts[3] === "messages") {
      const messages = ctx.sessionArchiveStore.getArchivedMessages(sessionId);
      return Response.json({ sessionId, messages });
    }

    // GET /api/archive/:id
    const session = ctx.sessionArchiveStore.getArchivedSession(sessionId);
    if (!session) {
      return Response.json({ error: "Archived session not found" }, { status: 404 });
    }
    const messages = ctx.sessionArchiveStore.getArchivedMessages(sessionId);
    return Response.json({ session, messages });
  }

  if (pathname.startsWith("/api/archive/") && method === "PATCH") {
    const denied = await ctx.ensureApiAccess(sessionAccessAction(ctx, method), request, url, authContext);
    if (denied) return denied;

    const archiveParts = pathname.split("/").filter(Boolean);
    const sessionId = archiveParts[2];
    if (!sessionId) {
      return Response.json({ error: "Session ID required" }, { status: 400 });
    }
    if (archiveParts[3] !== "metadata") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
    const metadataPatch = parseSessionMetadataUpdateInput(payload);
    if (!metadataPatch) {
      return Response.json({ error: "Invalid metadata payload" }, { status: 400 });
    }
    const updated = ctx.sessionArchiveStore.updateArchivedSessionMetadata(sessionId, {
      ...metadataPatch,
      lastManagedByNpub: authContext.subjectNpub ?? authContext.npub ?? undefined,
    });
    if (!updated) {
      return Response.json({ error: "Archived session not found" }, { status: 404 });
    }
    return Response.json(buildSessionMetadataResponse(sessionId, updated.metadata));
  }

  if (pathname.startsWith("/api/archive/") && method === "DELETE") {
    const denied = await ctx.ensureApiAccess(sessionAccessAction(ctx, method), request, url, authContext);
    if (denied) return denied;

    const archiveParts = pathname.split("/").filter(Boolean);
    const sessionId = archiveParts[2];
    if (!sessionId) {
      return Response.json({ error: "Session ID required" }, { status: 400 });
    }
    const deleted = ctx.sessionArchiveStore.deleteArchivedSession(sessionId);
    if (!deleted) {
      return Response.json({ error: "Archived session not found" }, { status: 404 });
    }
    return Response.json({ id: sessionId, deleted: true });
  }

  // ──────────────────────────────────────────────
  //  SSE stream for live session list updates
  // ──────────────────────────────────────────────

  if (pathname === "/api/sessions/subscribe" && method === "GET") {
    const viewerNpub = ctx.getViewerNormalizedNpub(authContext);
    if (!viewerNpub) {
      return Response.json({ error: "Not authenticated" }, { status: 401 });
    }
    return ctx.createSessionSubscribeResponse(viewerNpub);
  }

  // ──────────────────────────────────────────────
  //  Delegate session API for owner-linked bot identities
  // ──────────────────────────────────────────────

  if (pathname === "/api/delegate-sessions" && method === "GET") {
    const denied = await ctx.ensureApiAccess(sessionAccessAction(ctx, method), request, url, authContext);
    if (denied) return denied;
    if (!isProgrammaticCaller(authContext)) {
      return Response.json({ error: "nip98-auth-required" }, { status: 403 });
    }
    const viewerNormalizedNpub = normaliseNpub(authContext.delegatedOwnerNpub ?? null);
    if (!viewerNormalizedNpub) {
      return Response.json({ error: "legacy-delegate-owner-not-configured" }, { status: 403 });
    }
    const sessions = ctx.manager
      .listSessions()
      .filter((session) => ctx.sessionBelongsToViewer(session.npub ?? null, session.metadata, viewerNormalizedNpub, false))
      .map(ctx.serializeSession);
    return Response.json({ sessions });
  }

  if (pathname === "/api/delegate-sessions" && method === "POST") {
    const denied = await ctx.ensureApiAccess(sessionAccessAction(ctx, method), request, url, authContext);
    if (denied) return denied;
    if (!isProgrammaticCaller(authContext)) {
      return Response.json({ error: "nip98-auth-required" }, { status: 403 });
    }

    try {
      const payload = (await request.json()) as Record<string, unknown> | null;
      const agent = typeof payload?.agent === "string" ? payload.agent.toLowerCase() : "";
      if (!ctx.isAgentType(agent)) {
        return Response.json({ error: "Invalid agent selection" }, { status: 400 });
      }
      const directoryInput = typeof payload?.directory === "string" ? payload.directory : undefined;
      const rawName =
        payload && typeof payload === "object" && payload !== null
          ? payload.name
          : null;
      let workspace: SessionWorkspaceRequest = null;
      try {
        workspace =
          payload && typeof payload === "object" && payload !== null
            ? ctx.parseSessionWorkspaceRequest(payload.workspace)
            : null;
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
      const sessionName = ctx.normaliseSessionNameInput(rawName);
      let workingDirectory: string;
      try {
        workingDirectory = await ctx.resolveSessionWorkingDirectory(directoryInput, workspace);
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
      let targetFile: string | undefined;
      try {
        targetFile = await resolveSessionTargetFile(
          workingDirectory,
          typeof payload?.targetFile === "string" ? payload.targetFile : undefined,
        );
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
      const delegatedMetadata =
        payload?.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
          ? payload.metadata as Record<string, unknown>
          : null;
      const ownerNpub = normaliseNpub(authContext.delegatedOwnerNpub ?? null);
      if (!ownerNpub) {
        return Response.json({ error: "legacy-delegate-owner-not-configured" }, { status: 403 });
      }
      const session = await ctx.manager.createSession(
        agent,
        workingDirectory,
        sessionName ?? undefined,
        buildProgrammaticOrigin(authContext),
        targetFile,
        ownerNpub ?? undefined,
        {
          ...(delegatedMetadata ?? {}),
          AGENT: true,
          ownerNpub,
          createdByNpub: authContext.subjectNpub ?? authContext.npub ?? undefined,
          lastManagedByNpub: authContext.subjectNpub ?? authContext.npub ?? undefined,
          chargeToNpub: ownerNpub,
        },
      );
      await recordLiveSession(ctx, session);
      return Response.json(ctx.serializeSession(session), { status: 201 });
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 500 });
    }
  }

  if (pathname.startsWith("/api/delegate-sessions/")) {
    const denied = await ctx.ensureApiAccess(sessionAccessAction(ctx, method), request, url, authContext);
    if (denied) return denied;
    if (!isProgrammaticCaller(authContext)) {
      return Response.json({ error: "nip98-auth-required" }, { status: 403 });
    }

    const parts = pathname.split("/");
    const id = parts[3];
    if (!id) {
      return Response.json({ error: "Session id required" }, { status: 400 });
    }

    const viewerNormalizedNpub = normaliseNpub(authContext.delegatedOwnerNpub ?? null);
    if (!viewerNormalizedNpub) {
      return Response.json({ error: "legacy-delegate-owner-not-configured" }, { status: 403 });
    }

    const delegatedResolution = resolveOwnedLiveSession(
      id,
      ctx.manager.listSessions(),
      viewerNormalizedNpub,
      false,
      ctx,
    );
    if (delegatedResolution.error) return delegatedResolution.error;
    const ownedSession = delegatedResolution.session;
    const resolvedId = delegatedResolution.resolvedId;

    if (method === "GET" && parts.length === 4) {
      if (!ownedSession) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json(ctx.serializeSession(ownedSession));
    }

    if (method === "DELETE" && parts.length === 4) {
      if (!ownedSession) return Response.json({ error: "Not found" }, { status: 404 });
      const session = await ctx.manager.stopSession(resolvedId);
      if (!session) return Response.json({ error: "Not found" }, { status: 404 });
      ctx.scheduleSessionArchive(resolvedId, ctx.manager);
      return Response.json(ctx.serializeSession(session));
    }

    if (parts[4] === "messages") {
      if (!ownedSession) return Response.json({ error: "Not found" }, { status: 404 });

      if (method === "GET") {
        const refresh = url.searchParams.get("refresh") === "true";
        const messages = await (
          refresh ? ctx.syncSessionMessages(resolvedId, true) : ctx.messageStore.listSessionMessages(resolvedId)
        );
        return Response.json({ id: resolvedId, messages });
      }

      if (method === "POST") {
        return handleDelegatedQueuedMessage(request, resolvedId, ownedSession, authContext, ctx);
      }
    }
  }

  const ownerRoute = matchOwnerSessionRoute(pathname);
  if (ownerRoute) {
    const requiredOwnerScope = resolveOwnerSessionScope(method, ownerRoute.remainder);
    const ownerSessionsAccess = resolveOwnerSessionAccess(
      authContext,
      ownerRoute.ownerNpub,
      requiredOwnerScope,
      ctx,
    );
    if (!ownerSessionsAccess) {
      return Response.json({ error: "Delegation required" }, { status: 403 });
    }

    const targetOwnerNpub = ownerSessionsAccess.ownerNpub;
    const ownerAuthContext = createOwnerScopedAuthContext(
      authContext,
      targetOwnerNpub,
      ownerSessionsAccess,
      requiredOwnerScope,
    );
    const chargeToNpub = getDelegatedBillingNpub(authContext, targetOwnerNpub, ownerSessionsAccess.delegation);
    const billingAuthContext =
      chargeToNpub
        ? { ...authContext, npub: chargeToNpub, targetOwnerNpub }
        : authContext;

    if (ownerRoute.remainder.length === 0 && method === "GET") {
      const denied = await ctx.ensureApiAccess(sessionAccessAction(ctx, method), request, url, ownerAuthContext);
      if (denied) return denied;
      const sessions = ctx.manager
        .listSessions()
        .filter((session) =>
          ctx.sessionBelongsToViewer(session.npub ?? null, session.metadata, normaliseNpub(targetOwnerNpub), false),
        )
        .sort(compareSessionsForTabs)
        .map(ctx.serializeSession);
      return Response.json({ ownerNpub: targetOwnerNpub, sessions });
    }

    if (ownerRoute.remainder.length === 0 && method === "POST") {
      const denied = await ctx.ensureApiAccess(sessionAccessAction(ctx, method), request, url, ownerAuthContext);
      if (denied) return denied;

      try {
        const payload = (await request.json()) as Record<string, unknown> | null;
        const agent = typeof payload?.agent === "string" ? payload.agent.toLowerCase() : "";
        if (!ctx.isAgentType(agent)) {
          return Response.json({ error: "Invalid agent selection" }, { status: 400 });
        }
        const directoryInput = typeof payload?.directory === "string" ? payload.directory : undefined;
        const rawName = payload && typeof payload === "object" && payload !== null ? payload.name : null;
        let workspace: SessionWorkspaceRequest = null;
        try {
          workspace =
            payload && typeof payload === "object" && payload !== null
              ? ctx.parseSessionWorkspaceRequest(payload.workspace)
              : null;
        } catch (error) {
          return Response.json({ error: (error as Error).message }, { status: 400 });
        }
        const sessionName = ctx.normaliseSessionNameInput(rawName);
        const delegatedWorkspace = buildDelegatedWorkspaceScope(
          ctx.resolveWorkspace(ownerAuthContext),
          ownerSessionsAccess.delegation,
        );
        let workingDirectory: string;
        try {
          workingDirectory = await ctx.resolveSessionWorkingDirectory(
            directoryInput,
            workspace,
            delegatedWorkspace,
          );
        } catch (error) {
          return Response.json({ error: (error as Error).message }, { status: 400 });
        }
        let targetFile: string | undefined;
        try {
          targetFile = await resolveSessionTargetFile(
            workingDirectory,
            typeof payload?.targetFile === "string" ? payload.targetFile : undefined,
          );
        } catch (error) {
          return Response.json({ error: (error as Error).message }, { status: 400 });
        }
        const delegatedMetadata =
          payload?.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
            ? payload.metadata as Record<string, unknown>
            : null;
        const session = await ctx.manager.createSession(
          agent,
          workingDirectory,
          sessionName ?? undefined,
          buildProgrammaticOrigin(authContext),
          targetFile,
          targetOwnerNpub,
          {
            ...buildManagedSessionMetadata(
              authContext,
              targetOwnerNpub,
              chargeToNpub,
              ownerSessionsAccess.delegation?.id ?? null,
              delegatedMetadata,
            ),
            AGENT: true,
          },
        );
        await recordLiveSession(ctx, session);
        return Response.json(ctx.serializeSession(session), { status: 201 });
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 500 });
      }
    }

    const id = ownerRoute.remainder[0];
    if (!id) {
      return Response.json({ error: "Session id required" }, { status: 400 });
    }
    const denied = await ctx.ensureApiAccess(sessionAccessAction(ctx, method), request, url, ownerAuthContext);
    if (denied) return denied;

    const sessionResolution = resolveOwnedLiveSession(
      id,
      ctx.manager.listSessions(),
      normaliseNpub(targetOwnerNpub),
      false,
      ctx,
    );
    if (sessionResolution.error) return sessionResolution.error;
    const ownedSession = sessionResolution.session;
    let resolvedId = sessionResolution.resolvedId;
    const storedSessionResolution =
      !ownedSession
        ? resolveOwnedStoredSession(id, normaliseNpub(targetOwnerNpub), false, ctx)
        : null;
    if (storedSessionResolution?.error) return storedSessionResolution.error;
    const storedOwnedSession = storedSessionResolution?.session ?? null;
    const recoveredSession = !ownedSession ? await rehydrateStoredSession(ctx, storedOwnedSession) : null;
    const liveOwnedSession = ownedSession ?? recoveredSession;
    if (!ownedSession && storedOwnedSession) {
      resolvedId = storedSessionResolution?.resolvedId ?? resolvedId;
    }

    if (method === "GET" && ownerRoute.remainder.length === 1) {
      if (liveOwnedSession) {
        return Response.json(ctx.serializeSession(liveOwnedSession));
      }
      if (storedOwnedSession) {
        return Response.json(serializeStoredSession(storedOwnedSession));
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    if (method === "PATCH" && ownerRoute.remainder.length === 1) {
      if (!ownedSession) return Response.json({ error: "Not found" }, { status: 404 });
      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
      }
      if (!payload || typeof payload !== "object") {
        return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
      }
      const desiredNameValue = (payload as Record<string, unknown>).name;
      const desiredName = typeof desiredNameValue === "string" ? desiredNameValue : "";
      const trimmedName = desiredName.trim();
      if (!trimmedName) {
        return Response.json({ error: "Session name is required" }, { status: 400 });
      }
      const requestedPosition = parseSessionPositionInput((payload as Record<string, unknown>).position);
      if (requestedPosition === null) {
        return Response.json({ error: "Session position must be a positive number" }, { status: 400 });
      }
      const renamed = ctx.manager.renameSession(resolvedId, trimmedName);
      if (!renamed) return Response.json({ error: "Not found" }, { status: 404 });
      ctx.manager.updateSessionMetadata(resolvedId, {
        lastManagedByNpub: authContext.subjectNpub ?? authContext.npub ?? undefined,
      });
      const ownedSessions = ctx.manager
        .listSessions()
        .filter((session) =>
          ctx.sessionBelongsToViewer(session.npub ?? null, session.metadata, normaliseNpub(targetOwnerNpub), false),
        );
      const updated = requestedPosition === undefined
        ? ctx.manager.getSession(resolvedId) ?? renamed
        : await reorderLiveSessionTabs(ctx, ownedSessions, resolvedId, requestedPosition);
      if (!updated) return Response.json({ error: "Not found" }, { status: 404 });
      await recordLiveSession(ctx, updated);
      return Response.json(ctx.serializeSession(updated));
    }

    if (method === "DELETE" && ownerRoute.remainder.length === 1) {
      if (!liveOwnedSession) return Response.json({ error: "Not found" }, { status: 404 });
      ctx.manager.updateSessionMetadata(resolvedId, {
        lastManagedByNpub: authContext.subjectNpub ?? authContext.npub ?? undefined,
      });
      const session = await ctx.manager.stopSession(resolvedId);
      if (!session) return Response.json({ error: "Not found" }, { status: 404 });
      ctx.scheduleSessionArchive(resolvedId, ctx.manager);
      return Response.json(ctx.serializeSession(session));
    }

    const subresource = ownerRoute.remainder[1];
    if (subresource === "metadata") {
      if (method === "GET") {
        const metadata = liveOwnedSession?.metadata ?? storedOwnedSession?.metadata;
        if (!metadata) return Response.json({ error: "Not found" }, { status: 404 });
        return Response.json(
          buildSessionMetadataResponse(resolvedId, metadata, targetOwnerNpub),
        );
      }
      if (method === "PATCH") {
        let payload: unknown;
        try {
          payload = await request.json();
        } catch {
          return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
        }
        const metadataPatch = parseSessionMetadataUpdateInput(payload);
        if (!metadataPatch) {
          return Response.json({ error: "Invalid metadata payload" }, { status: 400 });
        }
        const persistedPatch = {
          ...metadataPatch,
          lastManagedByNpub: authContext.subjectNpub ?? authContext.npub ?? undefined,
        };
        const updated = liveOwnedSession
          ? ctx.manager.updateSessionMetadata(resolvedId, persistedPatch)
          : null;
        if (liveOwnedSession && !updated) return Response.json({ error: "Not found" }, { status: 404 });
        const metadata = updated?.metadata ?? (
          storedOwnedSession
            ? persistStoredSessionMetadata(ctx, storedOwnedSession, persistedPatch)
            : null
        );
        if (!metadata) return Response.json({ error: "Not found" }, { status: 404 });
        if (updated) {
          ctx.messageStore.recordSession({
            id: updated.id,
            agent: updated.agent,
            startedAt: updated.startedAt,
            name: updated.name ?? undefined,
            npub: updated.npub ?? undefined,
            port: updated.port,
            pid: updated.pid ?? undefined,
            pm2Name: updated.pm2Name,
            tmuxSession: updated.tmuxSession,
            tmuxWindow: updated.tmuxWindow,
            workingDirectory: updated.workingDirectory ?? undefined,
            command: updated.command,
            runtimeStatus: updated.agentRuntimeStatus ?? null,
            origin: updated.origin ?? null,
            targetFile: updated.targetFile ?? undefined,
            metadata: updated.metadata,
          });
        }
        return Response.json(
          buildSessionMetadataResponse(resolvedId, metadata, targetOwnerNpub),
        );
      }
    }

    if (method === "GET" && subresource === "events") {
      if (!liveOwnedSession) return Response.json({ error: "Not found" }, { status: 404 });
      return ctx.handleSessionEvents(resolvedId, request);
    }

    if (subresource === "messages") {
      if (method === "GET") {
        const refresh = url.searchParams.get("refresh") === "true";
        const messages = await (
          refresh && liveOwnedSession
            ? ctx.syncSessionMessages(resolvedId, true)
            : ctx.messageStore.listSessionMessages(resolvedId)
        );
        return Response.json({ id: resolvedId, messages });
      }
      if (method === "POST") {
        if (!liveOwnedSession) return Response.json({ error: "Not found" }, { status: 404 });
        ctx.manager.updateSessionMetadata(resolvedId, {
          lastManagedByNpub: authContext.subjectNpub ?? authContext.npub ?? undefined,
          chargeToNpub: chargeToNpub ?? undefined,
        });
        return handlePostMessage(request, resolvedId, liveOwnedSession, billingAuthContext, ctx);
      }
    }

    if (method === "GET" && subresource === "history") {
      return handleSessionHistory(resolvedId, liveOwnedSession, normaliseNpub(targetOwnerNpub), false, ctx);
    }

    if (method === "POST" && subresource === "queue" && (ownerRoute.remainder[2] === "next" || ownerRoute.remainder[2] === "dispatch")) {
      if (!liveOwnedSession) return Response.json({ error: "Not found" }, { status: 404 });
      ctx.manager.updateSessionMetadata(resolvedId, {
        lastManagedByNpub: authContext.subjectNpub ?? authContext.npub ?? undefined,
        chargeToNpub: chargeToNpub ?? undefined,
      });
      return handleQueueNext(resolvedId, liveOwnedSession, billingAuthContext, ctx);
    }

    if (subresource === "queue") {
      return handleQueueRoutes(
        request,
        method,
        ["", "api", "sessions", resolvedId, "queue", ...ownerRoute.remainder.slice(2)],
        resolvedId,
        liveOwnedSession,
        billingAuthContext,
        ctx,
      );
    }
  }

  // ──────────────────────────────────────────────
  //  GET /api/sessions — list sessions with filtering
  // ──────────────────────────────────────────────

  if (pathname === "/api/sessions" && method === "GET") {
    const denied = await ctx.ensureApiAccess(sessionAccessAction(ctx, method), request, url, authContext);
    if (denied) return denied;

    const viewerNormalizedNpub = resolveSelfSpaceViewerNpub(authContext, ctx);
    const viewerIsAdmin = isConfiguredAdminNpub(ctx, viewerNormalizedNpub);
    const allSessions = ctx.manager.listSessions();
    const accessibleSessions = viewerIsAdmin
      ? allSessions
      : viewerNormalizedNpub
        ? allSessions.filter((session) =>
            ctx.sessionBelongsToViewer(session.npub ?? null, session.metadata, viewerNormalizedNpub, false),
          )
        : [];
    const filterParam = url.searchParams.get("npub");

    const normalizeFilterValue = (value: string | null): string | null | "__anonymous__" => {
      if (!value || value === "all") return null;
      if (value === "__anonymous__") return "__anonymous__";
      const normalized = normaliseNpub(value);
      return normalized ?? null;
    };

    const filterValue = normalizeFilterValue(filterParam);
    const filteredSessions = accessibleSessions.filter((session) => {
      if (filterValue === null) return true;
      const sessionNormalized = resolveSessionOwnerNpub(session.npub ?? null, session.metadata);
      if (filterValue === "__anonymous__") return sessionNormalized === null;
      return sessionNormalized === filterValue;
    });

    let identitySummaries = viewerIsAdmin
      ? ctx.buildIdentitySummaries(allSessions, viewerNormalizedNpub, { includeAll: true })
      : ctx.buildIdentitySummaries(accessibleSessions, viewerNormalizedNpub, { includeAll: false });

    const identityNpub = isDelegatedBotAuth(authContext)
      ? normaliseNpub(authContext.delegatedOwnerNpub ?? null)
      : normaliseNpub(authContext.npub ?? null);
    if (!viewerIsAdmin && identitySummaries.length === 0 && viewerNormalizedNpub && identityNpub) {
      const segment = deriveNpubSegment(identityNpub);
      const dataRoot = normalize(join(ctx.userIdentityRoot, segment));
      const logsRoot = normalize(join(dataRoot, "logs"));
      const attachmentsRoot = normalize(join(ctx.attachmentRoot, segment));
      const imagesRoot = normalize(join(ctx.imageRoot, segment));
      const viewerRecord = ctx.identityUserStore.getByNormalized(viewerNormalizedNpub);
      const ports = viewerRecord?.ports ?? ctx.identityUserStore.ensurePortsFor(identityNpub);
      identitySummaries = [
        {
          npub: identityNpub,
          normalizedNpub: viewerNormalizedNpub,
          segment,
          alias: generateIdentityAlias(identityNpub),
          ports,
          sessionIds: [],
          activeSessionIds: [],
          lastSeenAt: null,
          dataRoot,
          logsRoot,
          attachmentsRoot,
          imagesRoot,
        },
      ];
    }

    const npubFilters = identitySummaries.map((identity) => ({
      value: identity.normalizedNpub ?? "__anonymous__",
      npub: identity.npub,
      alias: identity.alias,
      label: identity.alias ?? identity.npub ?? "Anonymous",
      sessionCount: identity.sessionIds.length,
      activeCount: identity.activeSessionIds.length,
    }));

    return Response.json({
      sessions: filteredSessions.sort(compareSessionsForTabs).map(ctx.serializeSession),
      identities: identitySummaries,
      filters: {
        npubs: npubFilters,
        active: filterValue,
      },
    });
  }

  if (pathname === "/api/sessions/bulk-close-stale-auto" && method === "POST") {
    const denied = await ctx.ensureApiAccess(sessionAccessAction(ctx, method), request, url, authContext);
    if (denied) return denied;

    const viewerNormalizedNpub = resolveSelfSpaceViewerNpub(authContext, ctx);
    const viewerIsAdmin = isConfiguredAdminNpub(ctx, viewerNormalizedNpub);
    const sessions = ctx.manager.listSessions().filter((session) =>
      viewerIsAdmin || (
        viewerNormalizedNpub !== null
        && ctx.sessionBelongsToViewer(session.npub ?? null, session.metadata, viewerNormalizedNpub, false)
      ),
    );
    const result = await closeStaleStableAutoSessions({
      sessions,
      manager: ctx.manager,
      now: Date.now,
      getLastUpdatedAt: (sessionId) => ctx.messageStore.getSession(sessionId)?.lastUpdatedAt ?? null,
      getReadiness: async (session) => ctx.getPromptReadinessForSession?.(session) ?? {
        state: "unreachable",
        reason: "readiness-unavailable",
        retryAfterMs: 5000,
        observedAt: Date.now(),
      },
      onClosed: (sessionId) => ctx.scheduleSessionArchive(sessionId, ctx.manager),
    });
    return Response.json(result);
  }

  // ──────────────────────────────────────────────
  //  POST /api/sessions — create session
  // ──────────────────────────────────────────────

  if (pathname === "/api/sessions" && method === "POST") {
    const denied = await ctx.ensureApiAccess(sessionAccessAction(ctx, method), request, url, authContext);
    if (denied) return denied;

    try {
      const sessionOwnerNpub = resolveSelfSpaceViewerNpub(authContext, ctx);
      const payload = (await request.json()) as Record<string, unknown> | null;
      const agent = typeof payload?.agent === "string" ? payload.agent.toLowerCase() : "";
      if (!ctx.isAgentType(agent)) {
        return Response.json({ error: "Invalid agent selection" }, { status: 400 });
      }
      const directoryInput = typeof payload?.directory === "string" ? payload.directory : undefined;
      const rawName =
        payload && typeof payload === "object" && payload !== null
          ? payload.name
          : null;
      let workspace: SessionWorkspaceRequest = null;
      try {
        workspace =
          payload && typeof payload === "object" && payload !== null
            ? ctx.parseSessionWorkspaceRequest(payload.workspace)
            : null;
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
      const sessionName = ctx.normaliseSessionNameInput(rawName);
      let workingDirectory: string;
      try {
        workingDirectory = await ctx.resolveSessionWorkingDirectory(directoryInput, workspace);
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
      let origin: SessionOrigin | null = null;
      try {
        origin = ctx.parseSessionOriginInput(payload?.origin ?? null);
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
      let nightWatch: NightWatchStartOptions | null = null;
      try {
        nightWatch = ctx.parseNightWatchStartOptions(payload?.nightwatch ?? null);
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
      // Parse optional target file for writer-mode sessions
      let targetFile: string | undefined;
      try {
        targetFile = await resolveSessionTargetFile(
          workingDirectory,
          typeof payload?.targetFile === "string" ? payload.targetFile : undefined,
        );
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
      const rawMetadata =
        payload?.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
          ? payload.metadata as Record<string, unknown>
          : null;
      const callerRequestedAgent = rawMetadata?.AGENT === true;
      const rawModel = typeof payload?.model === "string" ? payload.model.trim() : "";
      const session = await ctx.manager.createSession(
        agent,
        workingDirectory,
        sessionName ?? undefined,
        origin,
        targetFile,
        sessionOwnerNpub ?? undefined,
        {
          ...(rawMetadata ?? {}),
          AGENT: callerRequestedAgent || isProgrammaticCaller(authContext),
          ownerNpub: sessionOwnerNpub ?? undefined,
          createdByNpub: authContext.subjectNpub ?? authContext.npub ?? undefined,
          lastManagedByNpub: authContext.subjectNpub ?? authContext.npub ?? undefined,
          chargeToNpub: sessionOwnerNpub ?? undefined,
        },
        rawModel.length > 0 ? rawModel : undefined,
      );
      if (nightWatch?.enabled) {
        ctx.enableNightWatch(session.id, {
          prompt: nightWatch.prompt,
          intervalMinutes: nightWatch.intervalMinutes,
          maxCycles: nightWatch.maxCycles,
        });
      }
      await recordLiveSession(ctx, session);
      return Response.json(ctx.serializeSession(session), { status: 201 });
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 500 });
    }
  }

  // ──────────────────────────────────────────────
  //  /api/sessions/:id/* — session CRUD + sub-resources
  // ──────────────────────────────────────────────

  if (pathname.startsWith("/api/sessions/")) {
    const parts = pathname.split("/");
    const id = parts[3];

    // SSE endpoint - check auth and handle specially
    if (method === "GET" && parts[4] === "events" && id) {
      const denied = await ctx.ensureApiAccess(sessionAccessAction(ctx, method), request, url, authContext);
      if (denied) return denied;

      const liveSession = ctx.manager.getSession(id);
      const viewerNormalizedNpub = resolveSelfSpaceViewerNpub(authContext, ctx);
      const viewerIsAdmin = isConfiguredAdminNpub(ctx, viewerNormalizedNpub);
      const ownedSession =
        liveSession && ctx.sessionBelongsToViewer(liveSession.npub ?? null, liveSession.metadata, viewerNormalizedNpub, viewerIsAdmin)
          ? liveSession
          : null;
      if (!ownedSession) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      return ctx.handleSessionEvents(id, request);
    }

    const denied = await ctx.ensureApiAccess(sessionAccessAction(ctx, method), request, url, authContext);
    if (denied) return denied;

    if (!id) {
      return Response.json({ error: "Session id required" }, { status: 400 });
    }

    const viewerNormalizedNpub = resolveSelfSpaceViewerNpub(authContext, ctx);
    const viewerIsAdmin = isConfiguredAdminNpub(ctx, viewerNormalizedNpub);
    if (!viewerIsAdmin && !viewerNormalizedNpub) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const sessionResolution = resolveOwnedLiveSession(
      id,
      ctx.manager.listSessions(),
      viewerNormalizedNpub,
      viewerIsAdmin,
      ctx,
    );
    if (sessionResolution.error) return sessionResolution.error;
    const ownedSession = sessionResolution.session;
    let resolvedId = sessionResolution.resolvedId;
    const storedSessionResolution =
      !ownedSession
        ? resolveOwnedStoredSession(id, viewerNormalizedNpub, viewerIsAdmin, ctx)
        : null;
    if (storedSessionResolution?.error) return storedSessionResolution.error;
    const storedOwnedSession = storedSessionResolution?.session ?? null;
    const recoveredSession = !ownedSession ? await rehydrateStoredSession(ctx, storedOwnedSession) : null;
    const liveOwnedSession = ownedSession ?? recoveredSession;
    if (!ownedSession && storedOwnedSession) {
      resolvedId = storedSessionResolution?.resolvedId ?? resolvedId;
    }

    if (method === "GET" && parts.length === 4) {
      if (liveOwnedSession) {
        return Response.json(ctx.serializeSession(liveOwnedSession));
      }
      if (storedOwnedSession) {
        return Response.json(serializeStoredSession(storedOwnedSession));
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    if (method === "PATCH" && parts.length === 4) {
      if (!ownedSession) return Response.json({ error: "Not found" }, { status: 404 });
      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
      }
      if (!payload || typeof payload !== "object") {
        return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
      }
      const record = payload as Record<string, unknown>;
      const desiredName = typeof record.name === "string" ? record.name : "";
      const trimmedName = desiredName.trim();
      if (!trimmedName) {
        return Response.json({ error: "Session name is required" }, { status: 400 });
      }
      const requestedPosition = parseSessionPositionInput(record.position);
      if (requestedPosition === null) {
        return Response.json({ error: "Session position must be a positive number" }, { status: 400 });
      }
      const renamed = ctx.manager.renameSession(resolvedId, trimmedName);
      if (!renamed) return Response.json({ error: "Not found" }, { status: 404 });
      const accessibleSessions = ctx.manager
        .listSessions()
        .filter((session) =>
          ctx.sessionBelongsToViewer(session.npub ?? null, session.metadata, viewerNormalizedNpub, viewerIsAdmin),
        );
      const updated = requestedPosition === undefined
        ? renamed
        : await reorderLiveSessionTabs(ctx, accessibleSessions, resolvedId, requestedPosition);
      if (!updated) return Response.json({ error: "Not found" }, { status: 404 });
      await recordLiveSession(ctx, updated);
      return Response.json(ctx.serializeSession(updated));
    }

    if (method === "DELETE" && parts.length === 4) {
      if (!liveOwnedSession) return Response.json({ error: "Not found" }, { status: 404 });
      if (!isAuthorizedCaller(authContext) && !isAgentManagedByMetadataOrOrigin(liveOwnedSession.metadata, liveOwnedSession.origin)) {
        return Response.json({ error: "Agents can only stop sessions with metadata.AGENT=true" }, { status: 403 });
      }
      const session = await ctx.manager.stopSession(resolvedId);
      if (!session) return Response.json({ error: "Not found" }, { status: 404 });
      ctx.scheduleSessionArchive(resolvedId, ctx.manager);
      return Response.json(ctx.serializeSession(session));
    }

    if (method === "POST" && parts[4] === "resume-native") {
      const archivedSessionResolution =
        liveOwnedSession || storedOwnedSession
          ? null
          : resolveOwnedArchivedSession(id, viewerNormalizedNpub, viewerIsAdmin, ctx);
      if (archivedSessionResolution?.error) return archivedSessionResolution.error;
      const sourceSession = liveOwnedSession ?? storedOwnedSession ?? archivedSessionResolution?.session;
      if (!sourceSession) return Response.json({ error: "Not found" }, { status: 404 });
      return createNativeResumeSession(sourceSession, authContext, ctx);
    }

    if (method === "POST" && parts[4] === "interrupt") {
      if (!liveOwnedSession) return Response.json({ error: "Not found" }, { status: 404 });
      const adapter = ctx.manager.getAdapter(resolvedId);
      if (!adapter) {
        return Response.json({ error: "This session does not expose an agent adapter" }, { status: 409 });
      }
      try {
        const interrupted = await adapter.interruptCurrentTurn();
        return interrupted
          ? Response.json({ id: resolvedId, interrupted: true })
          : Response.json({ error: "This session has no active interruptible turn" }, { status: 409 });
      } catch (error) {
        return Response.json({ error: `Failed to interrupt agent: ${(error as Error).message}` }, { status: 502 });
      }
    }

    if (method === "DELETE" && parts[4] === "storage") {
      if (liveOwnedSession && (liveOwnedSession.status === "starting" || liveOwnedSession.status === "running")) {
        return Response.json({ error: "Stop the session before deleting it" }, { status: 409 });
      }

      if (!ownedSession) {
        if (!viewerIsAdmin) {
          const storedRecord = ctx.messageStore
            .listSessions()
            .find((record) =>
              record.id === resolvedId &&
              ctx.sessionBelongsToViewer(record.npub, record.metadata, viewerNormalizedNpub, viewerIsAdmin),
            );
          if (!storedRecord) {
            return Response.json({ error: "Not found" }, { status: 404 });
          }
        } else if (!ctx.messageStore.listSessions().some((record) => record.id === resolvedId)) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
      }

      ctx.cancelPendingArchive(resolvedId);

      try {
        ctx.manager.deleteSession(resolvedId);
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
      ctx.messageStore.removeSession(resolvedId);
      return Response.json({ id: resolvedId, deleted: true });
    }

    if (parts[4] === "metadata") {
      if (method === "GET") {
        const metadata = liveOwnedSession?.metadata ?? storedOwnedSession?.metadata;
        if (!metadata) return Response.json({ error: "Not found" }, { status: 404 });
        return Response.json(buildSessionMetadataResponse(resolvedId, metadata));
      }
      if (method === "PATCH") {
        let payload: unknown;
        try {
          payload = await request.json();
        } catch {
          return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
        }
        const metadataPatch = parseSessionMetadataUpdateInput(payload);
        if (!metadataPatch) {
          return Response.json({ error: "Invalid metadata payload" }, { status: 400 });
        }
        const persistedPatch = {
          ...metadataPatch,
          lastManagedByNpub: authContext.subjectNpub ?? authContext.npub ?? undefined,
        };
        const updated = liveOwnedSession
          ? ctx.manager.updateSessionMetadata(resolvedId, persistedPatch)
          : null;
        if (liveOwnedSession && !updated) return Response.json({ error: "Not found" }, { status: 404 });
        const metadata = updated?.metadata ?? (
          storedOwnedSession
            ? persistStoredSessionMetadata(ctx, storedOwnedSession, persistedPatch)
            : null
        );
        if (!metadata) return Response.json({ error: "Not found" }, { status: 404 });
        if (updated) {
          ctx.messageStore.recordSession({
            id: updated.id,
            agent: updated.agent,
            startedAt: updated.startedAt,
            name: updated.name ?? undefined,
            npub: updated.npub ?? undefined,
            port: updated.port,
            pid: updated.pid ?? undefined,
            pm2Name: updated.pm2Name,
            tmuxSession: updated.tmuxSession,
            tmuxWindow: updated.tmuxWindow,
            workingDirectory: updated.workingDirectory ?? undefined,
            command: updated.command,
            runtimeStatus: updated.agentRuntimeStatus ?? null,
            origin: updated.origin ?? null,
            targetFile: updated.targetFile ?? undefined,
            metadata: updated.metadata,
          });
        }
        return Response.json(buildSessionMetadataResponse(resolvedId, metadata));
      }
    }

    if (method === "GET" && parts[4] === "logs") {
      if (!liveOwnedSession) return Response.json({ error: "Not found" }, { status: 404 });
      const logs = await ctx.manager.getLogs(resolvedId);
      if (!logs) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json({ id: resolvedId, logs });
    }

    // GET /api/sessions/:id/artifacts
    if (method === "GET" && parts[4] === "artifacts") {
      const artifacts = ctx.artifactsStore.listBySession(resolvedId);
      return Response.json({ artifacts });
    }

    // Note: SSE endpoint (/events) is handled earlier in the route chain

    if (parts[4] === "permissions") {
      if (!liveOwnedSession) return Response.json({ error: "Not found" }, { status: 404 });
      const adapter = ctx.manager.getAdapter(resolvedId);
      if (method === "GET" && parts.length === 5) {
        return Response.json({ id: resolvedId, permissions: adapter?.getPendingPermissions?.() ?? [] });
      }
      if (method === "POST" && parts[5]) {
        let payload: unknown;
        try {
          payload = await request.json();
        } catch {
          return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
        }
        const response = payload && typeof payload === "object"
          ? (payload as Record<string, unknown>).response
          : null;
        if (response !== "once" && response !== "always" && response !== "reject") {
          return Response.json({ error: "Permission response must be once, always, or reject" }, { status: 400 });
        }
        if (!adapter?.respondToPermission) {
          return Response.json({ error: "This agent does not expose interactive permissions" }, { status: 409 });
        }
        try {
          const ok = await adapter.respondToPermission(parts[5], response);
          return ok
            ? Response.json({ id: resolvedId, permissionId: parts[5], response, ok: true })
            : Response.json({ error: "Permission is no longer pending" }, { status: 404 });
        } catch (error) {
          const permissionError = error as Error & { status?: number };
          const status = Number.isInteger(permissionError.status) ? Number(permissionError.status) : 502;
          return Response.json(
            { error: `Failed to respond to permission: ${permissionError.message}` },
            { status },
          );
        }
      }
    }

    if (parts[4] === "messages") {
      if (parts[5] && parts[6] === "speech" && (method === "GET" || method === "POST")) {
        return handleMessageSpeech(request, method, resolvedId, parts[5], liveOwnedSession, authContext, ctx);
      }

      if (method === "GET") {
        const refresh = url.searchParams.get("refresh") === "true";
        const messages = await (
          refresh && liveOwnedSession
            ? ctx.syncSessionMessages(resolvedId, true)
            : ctx.messageStore.listSessionMessages(resolvedId)
        );
        return Response.json({ id: resolvedId, messages });
      }

      if (method === "POST") {
        if (!liveOwnedSession) return Response.json({ error: "Not found" }, { status: 404 });
        return handlePostMessage(request, resolvedId, liveOwnedSession, authContext, ctx);
      }
    }

    // GET /api/sessions/:id/history
    if (method === "GET" && parts[4] === "history") {
      return handleSessionHistory(resolvedId, liveOwnedSession, viewerNormalizedNpub, viewerIsAdmin, ctx);
    }

    if (method === "POST" && parts[4] === "queue" && (parts[5] === "next" || parts[5] === "dispatch")) {
      if (!liveOwnedSession) return Response.json({ error: "Not found" }, { status: 404 });
      return handleQueueNext(resolvedId, liveOwnedSession, authContext, ctx);
    }

    if (parts[4] === "queue") {
      return handleQueueRoutes(request, method, parts, resolvedId, liveOwnedSession, authContext, ctx);
    }

    if (method === "POST" && parts[4] === "branch-conversation") {
      if (!liveOwnedSession) return Response.json({ error: "Not found" }, { status: 404 });
      return handleBranchConversation(request, resolvedId, liveOwnedSession, authContext, ctx);
    }

    // Fork session to a new git worktree
    if (method === "POST" && parts[4] === "fork-to-worktree") {
      if (!liveOwnedSession) return Response.json({ error: "Not found" }, { status: 404 });
      return handleForkToWorktree(request, resolvedId, liveOwnedSession, authContext, ctx);
    }
  }

  return null;
}

// ---------- Private handler helpers ----------

async function handlePostMessage(
  request: Request,
  id: string,
  ownedSession: SessionSnapshot,
  authContext: RequestAuthContext,
  ctx: SessionApiContext,
): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  if (!payload || typeof payload !== "object") {
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const record = payload as Record<string, unknown>;
  const requestTypeRaw = typeof record.type === "string" ? record.type.trim().toLowerCase() : "user";
  const messageType = requestTypeRaw === "raw" ? "raw" : "user";
  const rawContent = typeof record.content === "string" ? record.content : "";
  const content = messageType === "raw" ? rawContent : rawContent.trim();

  if (!content) {
    return Response.json({ error: "Message content is required" }, { status: 400 });
  }

  const userNpub = resolveSessionChargeNpub(ownedSession.metadata, authContext.npub ?? null);
  if (!userNpub) {
    return Response.json({ error: "Sign in to send messages" }, { status: 403 });
  }

  const adapter = ctx.manager.getAdapter(id);

  if (messageType === "raw") {
    const result = await deliverSessionAgentMessage({
      agentHost: ctx.agentHost,
      buildAgentUrl: ctx.buildAgentUrl,
      agent: ownedSession.agent,
      port: ownedSession.port,
      content,
      type: messageType,
      pm2Name: ownedSession.pm2Name,
      adapter,
    });
    if (!result.ok) {
      return Response.json({ error: result.message }, { status: result.status });
    }
    return Response.json({ id, ok: true });
  }

  const liveSession = ctx.manager.getSession(id) ?? ownedSession;
  try {
    const retained = await retainBusyDirectAdapterPrompt({
      session: liveSession,
      adapter,
      content,
      getReadiness: ctx.getPromptReadinessForSession,
      addPrompt: (sessionId, prompt) => ctx.promptQueueStore.addPrompt(sessionId, prompt),
      maybeAutoDispatch: (session) => ctx.maybeAutoDispatchQueuedPrompt(session),
    });
    if (retained) {
      return Response.json({ id, queued: true, ...retained }, { status: 202 });
    }
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }

  try {
    const initialCount = ctx.messageStore.listSessionMessages(id).length;
    const sentAtMs = Date.now();
    const result = await deliverSessionAgentMessage({
      agentHost: ctx.agentHost,
      buildAgentUrl: ctx.buildAgentUrl,
      agent: ownedSession.agent,
      port: ownedSession.port,
      content,
      type: messageType,
      pm2Name: ownedSession.pm2Name,
      adapter,
    });
    if (!result.ok) {
      const normalizedResult = await normalizeBusySessionMessageFailure(ownedSession, result, adapter);
      if (normalizedResult.status === 409 && adapter?.deliversPromptsDirectly?.()) {
        try {
          const retained = retainDirectAdapterPrompt({
            session: liveSession,
            adapter,
            content,
            getReadiness: ctx.getPromptReadinessForSession,
            addPrompt: (sessionId, prompt) => ctx.promptQueueStore.addPrompt(sessionId, prompt),
            maybeAutoDispatch: (session) => ctx.maybeAutoDispatchQueuedPrompt(session),
          }, {
            state: "busy",
            reason: "direct-adapter-became-busy",
            retryAfterMs: 1000,
            observedAt: Date.now(),
          });
          return Response.json({ id, queued: true, ...retained }, { status: 202 });
        } catch (error) {
          return Response.json({ error: (error as Error).message }, { status: 400 });
        }
      }
      return Response.json(
        { error: normalizedResult.message },
        { status: normalizedResult.status },
      );
    }

    void ctx.manager.captureAgentapiCodexSessionIdFromPrompt?.(id, content, { sentAtMs });
    const messages = await ctx.waitForMessageUpdate(id, initialCount);
    return Response.json({ id, messages });
  } catch (error) {
    return Response.json(
      { error: `Failed to contact agent: ${(error as Error).message}` },
      { status: 502 },
    );
  }
}

function normalizeMessageRole(value: unknown): string {
  const role = typeof value === "string" ? value.trim().toLowerCase() : "";
  return role || "assistant";
}

function normalizeSpeechText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return normalizeSharedSpeechText(value).slice(0, MAX_SPEECH_TEXT_LENGTH);
}

function sanitizeSpeechSummary(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, 240);
}

function findSpeechMessage(messages: StoredMessage[], messageId: string): StoredMessage | null {
  return messages.find((message) => message.id === messageId) ?? null;
}

function findPreviousUserMessage(messages: StoredMessage[], targetMessage: StoredMessage): StoredMessage | null {
  const targetIndex = messages.findIndex((message) => message.id === targetMessage.id);
  if (targetIndex <= 0) {
    return null;
  }
  for (let index = targetIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const role = normalizeMessageRole(message.role);
    if (role === "user") {
      return message;
    }
  }
  return null;
}

function resolveSpeechSettings(
  ctx: SessionApiContext,
  npub: string | null,
): {
  provider?: "openrouter" | "local";
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  voice?: string;
  format?: string;
} | null {
  if (!npub || typeof ctx.userSettingsStore?.getAll !== "function") {
    return null;
  }
  const settings = ctx.userSettingsStore.getAll(npub);
  const provider = settings.speech_provider === "local" ? "local" : "openrouter";
  const speechApiKey = settings.speech_api_key?.trim() || "";
  const apiKey = provider === "local" ? "" : speechApiKey || settings.openai_api_key?.trim() || "";
  const baseUrl = settings.speech_base_url?.trim() ||
    (provider === "local" ? DEFAULT_LOCAL_SPEECH_BASE_URL : DEFAULT_SETTINGS_SPEECH_BASE_URL);
  const model = settings.speech_model?.trim() ||
    (provider === "local" ? DEFAULT_LOCAL_SPEECH_MODEL : DEFAULT_SETTINGS_SPEECH_MODEL);
  const voice = settings.speech_voice?.trim() ||
    (provider === "local" ? DEFAULT_LOCAL_SPEECH_VOICE : DEFAULT_SETTINGS_SPEECH_VOICE);
  const format = settings.speech_format?.trim() || DEFAULT_SETTINGS_SPEECH_FORMAT;
  return {
    provider,
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(model ? { model } : {}),
    ...(voice ? { voice } : {}),
    ...(format ? { format } : {}),
  };
}

function resolveSpeechSummarySettings(
  ctx: SessionApiContext,
  npub: string | null,
): {
  apiKey?: string;
  baseUrl: string;
  model: string;
} | null {
  if (!npub || typeof ctx.userSettingsStore?.getAll !== "function") {
    return null;
  }
  const settings = ctx.userSettingsStore.getAll(npub);
  const provider = settings.speech_provider === "local" ? "local" : "openrouter";
  const apiKey = provider === "local"
    ? ""
    : settings.speech_api_key?.trim() ||
      settings.openrouter_api_key?.trim() ||
      settings.openai_api_key?.trim() ||
      "";
  if (!apiKey && provider !== "local") {
    return null;
  }
  return {
    ...(apiKey ? { apiKey } : {}),
    baseUrl: settings.speech_summary_base_url?.trim() ||
      (provider === "local" ? DEFAULT_LOCAL_SPEECH_SUMMARY_BASE_URL : DEFAULT_SETTINGS_SPEECH_BASE_URL),
    model: settings.speech_summary_model?.trim() ||
      (provider === "local" ? DEFAULT_LOCAL_SPEECH_SUMMARY_MODEL : DEFAULT_SETTINGS_SPEECH_SUMMARY_MODEL),
  };
}

async function handleMessageSpeech(
  request: Request,
  method: HttpMethod,
  sessionId: string,
  messageId: string,
  liveOwnedSession: SessionSnapshot | null,
  authContext: RequestAuthContext,
  ctx: SessionApiContext,
): Promise<Response> {
  const messages = ctx.messageStore.listSessionMessages(sessionId);
  const message = findSpeechMessage(messages, messageId);
  if (!message) {
    return Response.json({ error: "Message not found" }, { status: 404 });
  }

  const role = normalizeMessageRole(message.role);
  if (role !== "assistant" && role !== "agent") {
    return Response.json({ error: "Speech is only available for assistant messages" }, { status: 400 });
  }

  const existing = ctx.messageStore.getMessageSpeechAttachment(sessionId, message.role, message.createdAt);
  if (method === "GET" || existing) {
    if (!existing) {
      return Response.json({ error: "Speech has not been generated for this message" }, { status: 404 });
    }
    return Response.json({ sessionId, messageId, speech: existing });
  }

  if (liveOwnedSession?.agentRuntimeStatus === "running") {
    return Response.json(
      { error: "Speech can only be generated after the agent response is complete" },
      { status: 409 },
    );
  }

  let payload: Record<string, unknown> | null = null;
  try {
    payload = await request.json() as Record<string, unknown>;
  } catch {
    payload = null;
  }

  const shouldSummarize = payload?.summary === true || payload?.mode === "summary";
  let speechText = normalizeSpeechText(payload?.text) || normalizeSpeechText(message.content);
  if (!speechText) {
    return Response.json({ error: "Message has no readable text" }, { status: 400 });
  }

  const storedSession = ctx.messageStore.getSession(sessionId);
  const sessionOwnerNpub = resolveSessionOwnerNpub(
    liveOwnedSession?.npub ?? storedSession?.npub ?? authContext.npub ?? null,
    liveOwnedSession?.metadata ?? storedSession?.metadata ?? null,
  ) ?? authContext.npub ?? null;
  const agent = liveOwnedSession?.agent ?? storedSession?.agent ?? "codex";
  const ownerSegment = deriveNpubSegment(sessionOwnerNpub);
  const settingsNpub = sessionOwnerNpub ?? authContext.npub;

  if (shouldSummarize) {
    const summaryConfig = resolveSpeechSummarySettings(ctx, settingsNpub);
    if (!summaryConfig) {
      return Response.json({ error: "Speech summary generation failed: No OpenRouter API key configured" }, { status: 502 });
    }
    const previousUserMessage = findPreviousUserMessage(messages, message);
    try {
      speechText = await generateSpeechSummary({
        userPrompt: previousUserMessage?.content ?? "",
        agentResponse: message.content,
        config: summaryConfig,
      });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      return Response.json({ error: `Speech summary generation failed: ${messageText}` }, { status: 502 });
    }
  }

  let generated;
  try {
    generated = await generateSpeechAudio({
      text: speechText,
      voice: typeof payload?.voice === "string" ? payload.voice : null,
      config: resolveSpeechSettings(ctx, settingsNpub),
    });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    return Response.json({ error: `Speech generation failed: ${messageText}` }, { status: 502 });
  }

  const directory = join(ctx.attachmentRoot, ownerSegment, agent, "speech");
  const filename = `message-speech-${Date.now()}-${randomUUID()}${resolveSpeechExtension(generated.format)}`;
  const relativePath = normalize(join(ownerSegment, agent, "speech", filename)).replace(/\\/g, "/");
  const publicPath = `/uploads/files/${relativePath}`;

  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, filename), generated.audio);
  } catch (error) {
    console.error("[message-speech] failed to persist generated audio", error);
    return Response.json({ error: "Failed to store generated speech" }, { status: 500 });
  }

  const attachment = ctx.messageStore.saveMessageSpeechAttachment({
    sessionId,
    messageRole: message.role,
    messageCreatedAt: message.createdAt,
    publicPath,
    relativePath,
    mimeType: generated.mimeType,
    voice: generated.voice,
    model: generated.model,
    summary: sanitizeSpeechSummary(speechText),
  });

  return Response.json({ sessionId, messageId, speech: attachment }, { status: 201 });
}

async function handleDelegatedQueuedMessage(
  request: Request,
  id: string,
  ownedSession: SessionSnapshot,
  authContext: RequestAuthContext,
  ctx: SessionApiContext,
): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  if (!payload || typeof payload !== "object") {
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const record = payload as Record<string, unknown>;
  const requestTypeRaw = typeof record.type === "string" ? record.type.trim().toLowerCase() : "user";
  const messageType = requestTypeRaw === "raw" ? "raw" : "user";
  if (messageType === "raw") {
    return handlePostMessage(request, id, ownedSession, authContext, ctx);
  }

  const content = typeof record.content === "string" ? record.content.trim() : "";
  if (!content) {
    return Response.json({ error: "Message content is required" }, { status: 400 });
  }

  const userNpub = resolveSessionChargeNpub(ownedSession.metadata, authContext.npub ?? null);
  if (!userNpub) {
    return Response.json({ error: "Sign in to send messages" }, { status: 403 });
  }

  let prompt: unknown;
  try {
    prompt = ctx.promptQueueStore.addPrompt(id, { content });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }

  const liveSession = ctx.manager.getSession(id) ?? ownedSession;
  const readiness = ctx.getPromptReadinessForSession
    ? await ctx.getPromptReadinessForSession(liveSession)
    : null;
  const readyForImmediateDispatch = readiness
    ? readiness.state === "ready"
    : liveSession.status === "running" && liveSession.agentRuntimeStatus === "stable";
  if (liveSession.status === "running" && readyForImmediateDispatch) {
    try {
      const result = await ctx.dispatchNextQueuedPromptForSession(liveSession, userNpub);
      return Response.json({ id, queued: false, prompt, ...result });
    } catch (error) {
      const queueError = error as Error & { name?: string; status?: number; payload?: Record<string, unknown> };
      if (queueError.name === "QueueDispatchError") {
        void ctx.maybeAutoDispatchQueuedPrompt(liveSession);
        if (queueError.status === 402 || queueError.status === 403) {
          return Response.json({ error: queueError.message, ...(queueError.payload ?? {}) }, { status: queueError.status });
        }
      }
    }
  } else if (readiness) {
    console.info(
      `[queue] delegated message queued session=${liveSession.id} readiness=${readiness.state}`
      + ` reason=${readiness.reason}`,
    );
  }
  void ctx.maybeAutoDispatchQueuedPrompt(liveSession);

  return Response.json({ id, queued: true, prompt }, { status: 202 });
}

async function handleSessionHistory(
  id: string,
  ownedSession: SessionSnapshot | null,
  viewerNormalizedNpub: string | null,
  viewerIsAdmin: boolean,
  ctx: SessionApiContext,
): Promise<Response> {
  // Check if session is running first
  if (ownedSession) {
    const messages = await ctx.syncSessionMessages(id, true);
    return Response.json({
      id,
      status: "live",
      session: ctx.serializeSession(ownedSession),
      messages,
    });
  }

  // Check wingman.db for abandoned session (server restart, etc.)
  const storedSession = ctx.messageStore.getSession(id);
  if (storedSession) {
    const isOwned = ctx.sessionBelongsToViewer(storedSession.npub, storedSession.metadata, viewerNormalizedNpub, viewerIsAdmin);
    if (isOwned) {
      const ownerNpub = resolveSessionOwnerNpub(storedSession.npub, storedSession.metadata);
      const messages = ctx.messageStore.listSessionMessages(id);
      return Response.json({
        id,
        status: "abandoned",
        session: {
          id: storedSession.id,
          agent: storedSession.agent,
          name: storedSession.name,
          npub: storedSession.npub,
          ownerNpub,
          identityAlias: generateIdentityAlias(ownerNpub),
          workingDirectory: storedSession.workingDirectory,
          startedAt: storedSession.startedAt,
          origin: storedSession.origin,
          metadata: storedSession.metadata,
        },
        messages,
      });
    }
  }

  // Check archive store
  const archivedSession = ctx.sessionArchiveStore.getArchivedSession(id);
  if (archivedSession) {
    const isOwned = ctx.sessionBelongsToViewer(archivedSession.npub, archivedSession.metadata, viewerNormalizedNpub, viewerIsAdmin);
    if (isOwned) {
      const ownerNpub = resolveSessionOwnerNpub(archivedSession.npub, archivedSession.metadata);
      const messages = ctx.sessionArchiveStore.getArchivedMessages(id);
      return Response.json({
        id,
        status: "archived",
        session: {
          id: archivedSession.id,
          agent: archivedSession.agent,
          name: archivedSession.name,
          npub: archivedSession.npub,
          ownerNpub,
          identityAlias: generateIdentityAlias(ownerNpub),
          workingDirectory: archivedSession.workingDirectory,
          startedAt: archivedSession.startedAt,
          archivedAt: archivedSession.archivedAt,
          origin: archivedSession.origin,
          metadata: archivedSession.metadata,
        },
        messages,
      });
    }
  }

  return Response.json({ error: "Session not found" }, { status: 404 });
}

async function handleQueueRoutes(
  request: Request,
  method: HttpMethod,
  parts: string[],
  id: string,
  ownedSession: SessionSnapshot | null,
  authContext: RequestAuthContext,
  ctx: SessionApiContext,
): Promise<Response> {
  if (method === "GET") {
    const prompts = ctx.promptQueueStore.getSessionQueue(id);
    return Response.json({ id, queue: { prompts, maxSize: 21 } });
  }

  if (method === "POST") {
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const record = payload as Record<string, unknown>;
    const content = typeof record.content === "string" ? record.content.trim() : "";

    if (!content) {
      return Response.json({ error: "Prompt content is required" }, { status: 400 });
    }

    try {
      const prompt = ctx.promptQueueStore.addPrompt(id, { content });
      if (!prompt) {
        return Response.json({ error: "Failed to add prompt to queue" }, { status: 400 });
      }
      if (ownedSession) {
        void ctx.maybeAutoDispatchQueuedPrompt(ownedSession);
      }
      return Response.json({ id, prompt });
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }
  }

  if (method === "PUT" && parts.length === 6) {
    const promptId = parts[5];
    if (!promptId) {
      return Response.json({ error: "Prompt ID required" }, { status: 400 });
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    if (!payload || typeof payload !== "object") {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const record = payload as Record<string, unknown>;
    const content = typeof record.content === "string" ? record.content.trim() : "";

    if (!content) {
      return Response.json({ error: "Prompt content is required" }, { status: 400 });
    }

    const updated = ctx.promptQueueStore.updatePromptContent(id, promptId, content);
    if (!updated) {
      return Response.json({ error: "Prompt not found or failed to update" }, { status: 404 });
    }

    return Response.json({ id, promptId, updated: true });
  }

  if (method === "DELETE" && parts.length === 6) {
    const promptId = parts[5];
    if (!promptId) {
      return Response.json({ error: "Prompt ID required" }, { status: 400 });
    }

    const deleted = ctx.promptQueueStore.deletePromptById(id, promptId);
    if (!deleted) {
      return Response.json({ error: "Prompt not found" }, { status: 404 });
    }

    return Response.json({ id, promptId, deleted: true });
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}

async function handleQueueNext(
  id: string,
  ownedSession: SessionSnapshot,
  authContext: RequestAuthContext,
  ctx: SessionApiContext,
): Promise<Response> {
  if (ctx.queueDispatchInFlight.has(id)) {
    return Response.json({ error: "Prompt dispatch already in progress" }, { status: 409 });
  }

  ctx.queueDispatchInFlight.add(id);
  try {
    const result = await ctx.dispatchNextQueuedPromptForSession(
      ownedSession,
      resolveSessionChargeNpub(ownedSession.metadata, authContext.npub ?? null),
    );
    return Response.json(result);
  } catch (error) {
    const queueError = error as Error & { name?: string; status?: number; payload?: Record<string, unknown> };
    if (queueError.name === "QueueDispatchError" && typeof queueError.status === "number") {
      return Response.json({ error: queueError.message, ...(queueError.payload ?? {}) }, { status: queueError.status });
    }
    console.error("[queue] failed to send queued prompt:", error);
    return Response.json({ error: "Failed to send queued prompt" }, { status: 500 });
  } finally {
    ctx.queueDispatchInFlight.delete(id);
  }
}

async function handleBranchConversation(
  request: Request,
  id: string,
  ownedSession: SessionSnapshot,
  authContext: RequestAuthContext,
  ctx: SessionApiContext,
): Promise<Response> {
  const sourceDirectory = ownedSession.workingDirectory;
  if (!sourceDirectory) {
    return Response.json({ error: "Source session has no working directory" }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const record = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  const requestedName = typeof record.name === "string" ? record.name.trim() : "";

  if (ownedSession.agent !== "codex") {
    return Response.json({ error: "Conversation branching currently requires a Codex session" }, { status: 400 });
  }
  const sourceMetadata = normaliseSessionMetadata(ownedSession.metadata);
  const nativeSession = sourceMetadata.nativeAgentSession;
  if (!nativeSession?.sessionId || nativeSession.agent !== "codex") {
    return Response.json({ error: "Source session does not have a native Codex session id to fork" }, { status: 409 });
  }
  if (nativeSession.workingDirectory && nativeSession.workingDirectory !== sourceDirectory) {
    return Response.json({ error: "Source native Codex session working directory does not match the Wingman session" }, { status: 409 });
  }

  let forkedCodexSession: CodexSessionForkResult;
  try {
    forkedCodexSession = await ctx.forkCodexSession({
      sourceSessionId: nativeSession.sessionId,
      workingDirectory: sourceDirectory,
    });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 409 });
  }

  const sourceName = typeof ownedSession.name === "string" && ownedSession.name.trim()
    ? ownedSession.name.trim()
    : id;
  const sessionName = requestedName ? requestedName.slice(0, 120) : `${sourceName} (branch)`;
  const ownerNpub = resolveSessionOwnerNpub(ownedSession.npub ?? null, sourceMetadata)
    ?? resolveSelfSpaceViewerNpub(authContext, ctx);

  let newSession: SessionSnapshot;
  try {
    newSession = await ctx.manager.createSession(
      ownedSession.agent,
      sourceDirectory,
      sessionName,
      { type: "conversation-branch", id, label: `Conversation branch from ${sourceName}` },
      await resolveStoredSessionTargetFile(sourceDirectory, ownedSession.targetFile),
      ownerNpub ?? undefined,
      {
        AGENT: false,
        billingMode: sourceMetadata.billingMode,
        nativeAgentSession: createNativeAgentSessionMetadata(
          "codex",
          forkedCodexSession.forkedSessionId,
          sourceDirectory,
          "manual",
        ),
        branchedFromWingmanSessionId: id,
        branchConversationMode: "full",
        ownerNpub: ownerNpub ?? undefined,
        createdByNpub: authContext.subjectNpub ?? authContext.npub ?? sourceMetadata.createdByNpub,
        lastManagedByNpub: authContext.subjectNpub ?? authContext.npub ?? undefined,
        chargeToNpub: resolveSessionChargeNpub(sourceMetadata, ownedSession.npub ?? null) ?? ownerNpub ?? undefined,
      },
      ownedSession.model,
    );
    await recordLiveSession(ctx, newSession);
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }

  const forkedMessages = await readCodexSessionMessagesFromFile(forkedCodexSession.forkedFilePath).catch(() => []);
  const rawSourceMessages = forkedMessages.length > 0
    ? forkedMessages
    : await ctx.syncSessionMessages(id, true);
  const sourceMessages = rawSourceMessages.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const message = value as Record<string, unknown>;
    if (
      typeof message.role !== "string" ||
      typeof message.content !== "string" ||
      typeof message.createdAt !== "string"
    ) return [];
    return [{ role: message.role, content: message.content, createdAt: message.createdAt }];
  });
  if (sourceMessages.length > 0) {
    ctx.messageStore.replaceMessages(
      newSession.id,
      sourceMessages.map((message) => ({
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
      })),
    );
  }

  return Response.json({
    session: ctx.serializeSession(newSession),
    sourceSessionId: id,
    nativeAgentSession: newSession.metadata?.nativeAgentSession ?? null,
    forkedCodexSession,
  }, { status: 201 });
}

async function handleForkToWorktree(
  request: Request,
  id: string,
  ownedSession: SessionSnapshot,
  authContext: RequestAuthContext,
  ctx: SessionApiContext,
): Promise<Response> {
  const sourceDirectory = ownedSession.workingDirectory;
  if (!sourceDirectory) {
    return Response.json({ error: "Source session has no working directory" }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  let forkInput: ReturnType<typeof ctx.validateForkInput>;
  try {
    forkInput = ctx.validateForkInput(payload);
    forkInput.sourceSessionId = id;
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }

  // Get recent messages from source session
  const contextMessages = ctx.getRecentMessages(ctx.messageStore, id, forkInput.messageCount ?? 5);

  // Create worktree
  let worktreeResult: Awaited<ReturnType<typeof ctx.createGitWorktree>>;
  try {
    worktreeResult = await ctx.createGitWorktree({
      directory: sourceDirectory,
      branch: forkInput.branch,
      startPoint: null,
    });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }

  // Create new session in the worktree with the same agent
  const sessionName = `${ownedSession.name || "session"} (${forkInput.branch})`;
  let newSession: SessionSnapshot;
  try {
    newSession = await ctx.manager.createSession(
      ownedSession.agent,
      worktreeResult.path,
      sessionName,
      { type: "fork", id: id, label: `Forked from ${ownedSession.name || id}` },
      undefined,
      authContext.npub ?? undefined,
      { AGENT: false },
    );
    ctx.messageStore.recordSession({
      id: newSession.id,
      agent: newSession.agent,
      startedAt: newSession.startedAt,
      name: newSession.name,
      npub: newSession.npub,
      port: newSession.port,
      pid: newSession.pid,
      workingDirectory: newSession.workingDirectory,
      command: newSession.command,
      runtimeStatus: newSession.agentRuntimeStatus ?? null,
      origin: newSession.origin ?? null,
      pm2Name: newSession.pm2Name,
      tmuxSession: newSession.tmuxSession,
      tmuxWindow: newSession.tmuxWindow,
      metadata: newSession.metadata,
    });
    await ctx.syncSessionMessages(newSession.id, true);
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }

  // Format context for injection
  const initialPrompt = ctx.formatMessagesAsContext(contextMessages);

  return Response.json({
    session: ctx.serializeSession(newSession),
    contextMessages,
    worktreePath: worktreeResult.path,
    sourceSessionId: id,
    initialPrompt,
  }, { status: 201 });
}

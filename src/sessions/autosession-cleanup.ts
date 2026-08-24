export const AUTOSESSION_STALE_MINUTES = 63;

const LEGACY_AUTO_ORIGIN_TYPES = new Set([
  "scheduler",
  "nostr",
  "mg-task",
  "file-watcher",
  "agent-session",
]);

const PROGRAMMATIC_ORIGIN_TYPES = new Set(["cli", "delegate-bot"]);

const DISPATCHED_WORKER_ORIGIN_TYPE = "session-dispatch";
const DISPATCHED_WORKER_ROLE = "dispatched-worker";

export interface AutosessionCleanupCandidate {
  id?: string;
  lastUpdatedAt?: string | null;
  npub?: string | null;
  ownerNpub?: string | null;
  origin?: { type?: string | null } | null;
  metadata?: {
    AGENT?: boolean;
    ownerNpub?: string | null;
    createdByNpub?: string | null;
    role?: string | null;
    bindingType?: string | null;
    routedBy?: string | null;
  } | null;
}

export interface AutosessionCleanupDecision {
  eligible: boolean;
  reason: "eligible" | "self" | "user-started" | "missing-last-updated-at" | "not-stale";
}

const normaliseText = (value: unknown): string => typeof value === "string" ? value.trim() : "";

export function isAutomaticallyStartedSession(session: AutosessionCleanupCandidate): boolean {
  const metadata = session.metadata ?? {};
  const originType = normaliseText(session.origin?.type).toLowerCase();
  const ownerNpub = normaliseText(session.ownerNpub)
    || normaliseText(metadata.ownerNpub)
    || normaliseText(session.npub);
  const createdByNpub = normaliseText(metadata.createdByNpub);
  const createdByDifferentNpub = Boolean(ownerNpub && createdByNpub && ownerNpub !== createdByNpub);

  return metadata.AGENT === true
    || createdByDifferentNpub
    || PROGRAMMATIC_ORIGIN_TYPES.has(originType)
    || LEGACY_AUTO_ORIGIN_TYPES.has(originType)
    || originType === DISPATCHED_WORKER_ORIGIN_TYPE
    || originType === "agent-work"
    || originType === "agent-chat"
    || metadata.role === DISPATCHED_WORKER_ROLE
    || metadata.role === "agent-work"
    || metadata.role === "agent-chat"
    || metadata.bindingType === "task"
    || metadata.bindingType === "flow_run"
    || metadata.routedBy === "agent-chat";
}

export function assessAutosessionCleanupCandidate(
  session: AutosessionCleanupCandidate,
  options: { currentSessionId: string; nowMs: number; staleMinutes?: number },
): AutosessionCleanupDecision {
  const sessionId = typeof session.id === "string" ? session.id.trim() : "";
  if (sessionId && sessionId === options.currentSessionId) {
    return { eligible: false, reason: "self" };
  }

  if (!isAutomaticallyStartedSession(session)) {
    return { eligible: false, reason: "user-started" };
  }

  if (typeof session.lastUpdatedAt !== "string" || !session.lastUpdatedAt.trim()) {
    return { eligible: false, reason: "missing-last-updated-at" };
  }
  const lastUpdatedAtMs = Date.parse(session.lastUpdatedAt);
  if (!Number.isFinite(lastUpdatedAtMs)) {
    return { eligible: false, reason: "missing-last-updated-at" };
  }

  const staleAfterMs = (options.staleMinutes ?? AUTOSESSION_STALE_MINUTES) * 60 * 1000;
  if (options.nowMs - lastUpdatedAtMs <= staleAfterMs) {
    return { eligible: false, reason: "not-stale" };
  }

  return { eligible: true, reason: "eligible" };
}

export async function cleanupStaleAutosessions(
  sessions: AutosessionCleanupCandidate[],
  options: {
    currentSessionId: string;
    nowMs: number;
    stopSession: (sessionId: string) => Promise<void>;
  },
) {
  const stopped: string[] = [];
  const skipped: Array<{ id: string; reason: AutosessionCleanupDecision["reason"] }> = [];

  for (const session of sessions) {
    const id = typeof session.id === "string" ? session.id.trim() : "";
    if (!id) continue;
    const decision = assessAutosessionCleanupCandidate(session, options);
    if (!decision.eligible) {
      skipped.push({ id, reason: decision.reason });
      continue;
    }
    await options.stopSession(id);
    stopped.push(id);
  }

  return { stopped, skipped };
}

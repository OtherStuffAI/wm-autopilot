import { deriveConversationPresentation, getTurnWindowStart } from "./conversation-presentation.js";

export const LIVE_MESSAGE_WINDOW_DEFAULT = 80;
export const LIVE_MESSAGE_PAGE_SIZE = 80;

function clampVisibleCount(totalCount, visibleCount) {
  const safeTotal = Math.max(0, totalCount);
  const safeVisible = Math.max(0, Math.trunc(visibleCount));
  return Math.min(safeTotal, safeVisible);
}

export function createWindowRecord(totalCount, visibleCount = LIVE_MESSAGE_WINDOW_DEFAULT) {
  return {
    visibleCount: clampVisibleCount(totalCount, visibleCount),
    lastTotal: Math.max(0, totalCount),
  };
}

export function syncConversationWindow(windowStore, sessionId, totalCount) {
  const safeTotal = Math.max(0, totalCount);
  const current = windowStore.get(sessionId);
  if (!current) {
    const initial = createWindowRecord(safeTotal, LIVE_MESSAGE_WINDOW_DEFAULT);
    windowStore.set(sessionId, initial);
    return initial;
  }

  const previousTotal = Math.max(0, current.lastTotal ?? 0);
  const next = {
    visibleCount: clampVisibleCount(safeTotal, current.visibleCount ?? LIVE_MESSAGE_WINDOW_DEFAULT),
    lastTotal: safeTotal,
  };

  if (safeTotal <= LIVE_MESSAGE_WINDOW_DEFAULT) {
    next.visibleCount = safeTotal;
  } else if (next.visibleCount === 0) {
    next.visibleCount = Math.min(safeTotal, LIVE_MESSAGE_WINDOW_DEFAULT);
  } else if (next.visibleCount >= previousTotal) {
    next.visibleCount = safeTotal;
  }

  windowStore.set(sessionId, next);
  return next;
}

export function expandConversationWindow(windowStore, sessionId, totalCount, step = LIVE_MESSAGE_PAGE_SIZE) {
  const current = syncConversationWindow(windowStore, sessionId, totalCount);
  const next = {
    visibleCount: clampVisibleCount(totalCount, current.visibleCount + Math.max(1, Math.trunc(step))),
    lastTotal: Math.max(0, totalCount),
  };
  windowStore.set(sessionId, next);
  return next;
}

export function resetConversationWindow(windowStore, sessionId) {
  windowStore.delete(sessionId);
}

export function getConversationWindowSnapshot(windowStore, sessionId, conversation) {
  const items = deriveConversationPresentation(conversation);
  const totalCount = items.length;
  const windowRecord = syncConversationWindow(windowStore, sessionId, totalCount);
  const hiddenCount = getTurnWindowStart(items, windowRecord.visibleCount);
  const visibleCount = totalCount - hiddenCount;
  const visibleMessages = items.slice(hiddenCount);

  return {
    totalCount,
    visibleCount,
    hiddenCount,
    visibleMessages,
  };
}

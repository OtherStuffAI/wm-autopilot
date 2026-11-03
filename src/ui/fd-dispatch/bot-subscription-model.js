// Pure presentation helpers for per-bot Flight Deck delivery paths (rows from GET /api/agent-chat/bot-subscriptions).

export const BOT_SUBSCRIPTION_STATUS = Object.freeze({
  inbox: { label: 'Addressed inbox', tone: 'ok', summary: 'Receives only work addressed to this bot through its own inbox.' },
  legacy_profile: { label: 'Legacy feed', tone: 'warn', summary: 'Own subscription, but still reading the legacy workspace event feed.' },
  legacy_shared: { label: 'Shared feed', tone: 'warn', summary: 'One legacy subscription serving several bots. Stays visible until retired.' },
  not_migrated: { label: 'Not migrated', tone: 'warn', summary: 'Served through a shared legacy feed, not its own inbox.' },
  blocked: { label: 'Blocked', tone: 'error', summary: 'Delivery is halted for this bot.' },
  disconnected: { label: 'Disconnected', tone: 'muted', summary: 'Subscription is paused, disconnected or revoked.' },
});

export function botSubscriptionStatus(row) {
  return BOT_SUBSCRIPTION_STATUS[row?.status] || { label: 'Unknown', tone: 'muted', summary: 'Status not recognised by this page.' };
}

export function botSubscriptionBotLabel(row) {
  if (row?.kind === 'shared') return 'Shared workspace feed';
  return row?.botLabel?.trim() || row?.agentId || 'Unnamed bot';
}

export function botSubscriptionWorkspaceLabel(row) {
  return row?.workspaceName?.trim() || 'Workspace title unavailable';
}

export function formatBotSubscriptionTime(value, fallback = 'Never') {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Time unavailable' : date.toLocaleString();
}

/** Human summary of the strict inbox poller; null when the row is not on an inbox. */
export function botSubscriptionInboxSummary(row) {
  if (!row?.inbox) return null;
  return {
    established: row.inbox.towerSubscriptionEstablished ? 'Tower inbox established' : 'Tower inbox not established',
    floor: row.inbox.floorAt ? `Initial floor ${formatBotSubscriptionTime(row.inbox.floorAt)} (fixed 24h look-back)` : 'Initial floor not recorded',
    lastOk: `Last inbox read ${formatBotSubscriptionTime(row.inbox.lastOkAt)}`,
    lastGap: row.inbox.lastGapAt ? `Last gap reported ${formatBotSubscriptionTime(row.inbox.lastGapAt)}` : null,
  };
}

export function botSubscriptionError(row) {
  if (!row?.error) return null;
  const at = row.error.at ? ` (${formatBotSubscriptionTime(row.error.at)})` : '';
  return `${row.error.code}${at}`;
}

/** Tower classification is reported separately; inbox opt-in alone never implies restriction. */
export function botSubscriptionClassificationLabel(row, record) {
  if (row?.kind !== 'profile') return 'Not applicable (shared feed)';
  if (!record) return 'Not checked';
  // Restored checks are history, not live enforcement: always say when they were taken and that they are saved.
  const when = `${record.cached ? 'saved check from' : 'checked'} ${formatBotSubscriptionTime(record.checkedAt, 'unknown time')}`;
  if (record.state === 'classified') return `Notification-only (${when})`;
  if (record.state === 'unclassified') return `Not classified${record.profile ? ` (${record.profile})` : ''} (${when})`;
  return `Check failed: ${record.error || 'unknown error'} (${when})`;
}

/** Dispatch-outcome filter for a selected row. Shared rows show the whole shared feed; bot rows are agent-scoped. */
export function botSubscriptionOutcomeFilter(row) {
  if (!row) return null;
  if (row.kind === 'shared') return { subscriptionId: row.subscriptionId };
  if (!row.agentId) return null;
  return { subscriptionId: row.subscriptionId, agentId: row.agentId };
}

/**
 * A bot with its own subscription may still have earlier activity on a shared legacy feed in the same workspace.
 * Return that shared row so the operator can view the bot's prior activity there explicitly.
 */
export function botSubscriptionLegacyFeed(row, rows) {
  if (row?.kind !== 'profile' || !row.agentId) return null;
  return rows.find((candidate) => candidate.kind === 'shared'
    && candidate.workspaceId === row.workspaceId
    && candidate.backendBaseUrl === row.backendBaseUrl) || null;
}

/**
 * Client-side guard: a scoped view never renders outcomes from another subscription or bot, even if an older backend
 * ignores the filter parameters and returns unfiltered history.
 */
export function scopeOutcomeRows(rows, filter) {
  if (!filter) return rows;
  return rows.filter((row) => row?.subscriptionId === filter.subscriptionId
    && (!filter.agentId || row?.agentId === filter.agentId));
}

export function describeOutcomeScope(row, filter) {
  if (!row || !filter) return 'All delivery paths';
  const workspace = botSubscriptionWorkspaceLabel(row);
  if (row.kind === 'shared') return `Shared workspace feed in ${workspace} (all bots it serves)`;
  if (row.kind === 'served_by_shared' || filter.subscriptionId !== row.subscriptionId) {
    return `${botSubscriptionBotLabel(row)} via shared feed in ${workspace}`;
  }
  return `${botSubscriptionBotLabel(row)} in ${workspace}`;
}

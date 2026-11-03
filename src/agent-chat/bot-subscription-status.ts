import type { AgentInboxState } from './agent-inbox-store';
import type { AgentDefinitionRecord, WorkspaceSubscriptionRecord } from './types';

/**
 * Operator view of how each bot actually receives Flight Deck work in each workspace.
 *
 * One row per real delivery path: a profile-bound subscription, a shared (legacy) subscription, and each bot that a
 * shared subscription still serves. Status is derived only from stored state; nothing is assumed isolated.
 * Tower classification is read separately (it needs a signed request) and never inferred here.
 */
export type BotSubscriptionStatus =
  | 'inbox'          // profile-bound, strict agent inbox, polling cleanly (classification reported separately)
  | 'blocked'        // strict inbox halted/unsupported/key missing, or Tower rejected the bot from the audience
  | 'legacy_profile' // profile-bound but still on the legacy /events feed
  | 'legacy_shared'  // a shared subscription serving several bots via the legacy audience
  | 'not_migrated'   // a bot served only through a shared legacy subscription
  | 'disconnected';  // subscription disabled, locally disconnected or revoked

export type BotSubscriptionKind = 'profile' | 'shared' | 'served_by_shared';

export interface BotSubscriptionRow {
  rowId: string;
  kind: BotSubscriptionKind;
  status: BotSubscriptionStatus;
  statusDetail: string | null;
  subscriptionId: string;
  sharedSubscriptionId: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  backendBaseUrl: string;
  agentId: string | null;
  botLabel: string | null;
  botNpub: string;
  servedAgentIds: string[];
  connection: string;
  health: string;
  lifecycle: string;
  lastSuccessfulPollAt: string | null;
  inbox: {
    towerSubscriptionEstablished: boolean;
    floorAt: string | null;
    lastOkAt: string | null;
    lastGapAt: string | null;
  } | null;
  error: { code: string; errorClass: string | null; at: string | null } | null;
}

export interface BotSubscriptionInputs {
  subscriptions: WorkspaceSubscriptionRecord[];
  agents: AgentDefinitionRecord[];
  inboxState: (subscriptionId: string) => AgentInboxState | null;
  /** Locally configured legacy audience for a shared subscription (excludes inbox profiles). */
  sharedAudience: (record: WorkspaceSubscriptionRecord) => AgentDefinitionRecord[];
  workspaceName: (record: WorkspaceSubscriptionRecord) => string | null;
}

const INBOX_BLOCKING_PREFIXES = ['agent_inbox_halt', 'agent_inbox_unsupported'];

function isInactive(record: WorkspaceSubscriptionRecord): boolean {
  return (record.lifecycleStatus ?? 'active') !== 'active' || record.sseStatus === 'disabled';
}

function lastGapAt(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { at?: unknown };
    return typeof parsed.at === 'string' ? parsed.at : null;
  } catch {
    return null;
  }
}

function errorOf(record: WorkspaceSubscriptionRecord, inbox: AgentInboxState | null): BotSubscriptionRow['error'] {
  const code = record.lastErrorCode ?? record.lastEventPollErrorCode ?? inbox?.lastErrorCode ?? null;
  if (!code) return null;
  return {
    code,
    errorClass: inbox?.lastErrorCode === code ? inbox.lastErrorClass : null,
    at: record.lastErrorAt ?? record.lastEventPollErrorAt ?? inbox?.lastErrorAt ?? null,
  };
}

/** Audience members Tower reported as rejected on the shared subscription's last reconciliation. */
function rejectedAudience(record: WorkspaceSubscriptionRecord): Map<string, string> {
  const details = record.lastRoutingResult?.details as { rejected_audience?: unknown } | undefined;
  const rejected = Array.isArray(details?.rejected_audience) ? details.rejected_audience : [];
  return new Map(rejected
    .filter((entry): entry is { npub: string; code?: unknown } => typeof entry?.npub === 'string')
    .map((entry) => [entry.npub, typeof entry.code === 'string' ? entry.code : 'not_accepted']));
}

function profileStatus(record: WorkspaceSubscriptionRecord, inbox: AgentInboxState | null): Pick<BotSubscriptionRow, 'status' | 'statusDetail'> {
  if (isInactive(record)) return { status: 'disconnected', statusDetail: record.lastErrorCode ?? record.lifecycleStatus ?? 'disabled' };
  if (inbox?.mode !== 'inbox_required') return { status: 'legacy_profile', statusDetail: 'Profile-bound subscription still uses the legacy event feed.' };
  const code = record.lastErrorCode ?? '';
  if (INBOX_BLOCKING_PREFIXES.some((prefix) => code.startsWith(prefix))) return { status: 'blocked', statusDetail: code };
  if (!inbox.towerSubscriptionId) return { status: 'blocked', statusDetail: inbox.lastErrorCode ?? 'Tower inbox subscription not established yet.' };
  return { status: 'inbox', statusDetail: null };
}

function baseRow(record: WorkspaceSubscriptionRecord, inputs: BotSubscriptionInputs) {
  return {
    subscriptionId: record.subscriptionId,
    workspaceId: record.workspaceId ?? null,
    workspaceName: inputs.workspaceName(record),
    backendBaseUrl: record.backendBaseUrl,
    connection: record.sseStatus,
    health: record.healthStatus,
    lifecycle: record.lifecycleStatus ?? 'active',
    lastSuccessfulPollAt: record.lastEventPollOkAt ?? null,
  };
}

export function buildBotSubscriptionRows(inputs: BotSubscriptionInputs): BotSubscriptionRow[] {
  const agentsById = new Map(inputs.agents.map((agent) => [agent.agentId, agent]));
  const rows: BotSubscriptionRow[] = [];
  for (const record of inputs.subscriptions) {
    const inbox = inputs.inboxState(record.subscriptionId);
    if (record.agentProfileId) {
      const agent = agentsById.get(record.agentProfileId) ?? null;
      rows.push({
        ...baseRow(record, inputs),
        rowId: `profile:${record.subscriptionId}`,
        kind: 'profile',
        ...profileStatus(record, inbox),
        sharedSubscriptionId: null,
        agentId: record.agentProfileId,
        botLabel: agent?.label ?? null,
        botNpub: record.botNpub,
        servedAgentIds: [record.agentProfileId],
        inbox: inbox?.mode === 'inbox_required' ? {
          towerSubscriptionEstablished: Boolean(inbox.towerSubscriptionId),
          floorAt: inbox.floorAt,
          lastOkAt: inbox.lastOkAt,
          lastGapAt: lastGapAt(inbox.lastGap),
        } : null,
        error: errorOf(record, inbox),
      });
      continue;
    }
    const inactive = isInactive(record);
    const audience = inactive ? [] : inputs.sharedAudience(record);
    rows.push({
      ...baseRow(record, inputs),
      rowId: `shared:${record.subscriptionId}`,
      kind: 'shared',
      status: inactive ? 'disconnected' : 'legacy_shared',
      statusDetail: inactive ? record.lastErrorCode ?? record.lifecycleStatus ?? 'disabled' : null,
      sharedSubscriptionId: null,
      agentId: null,
      botLabel: null,
      botNpub: record.botNpub,
      servedAgentIds: audience.map((agent) => agent.agentId),
      inbox: null,
      error: errorOf(record, null),
    });
    const rejected = rejectedAudience(record);
    for (const agent of audience) {
      const rejection = rejected.get(agent.botNpub);
      rows.push({
        ...baseRow(record, inputs),
        rowId: `served:${record.subscriptionId}:${agent.agentId}`,
        kind: 'served_by_shared',
        status: rejection ? 'blocked' : 'not_migrated',
        statusDetail: rejection ? `Tower rejected this bot from the shared audience (${rejection}).` : 'Served by the shared legacy subscription.',
        sharedSubscriptionId: record.subscriptionId,
        agentId: agent.agentId,
        botLabel: agent.label,
        botNpub: agent.botNpub,
        servedAgentIds: [agent.agentId],
        inbox: null,
        error: rejection ? { code: rejection, errorClass: 'audience', at: record.lastRoutingResult?.at ?? null } : null,
      });
    }
  }
  return rows.sort((a, b) => String(a.workspaceId).localeCompare(String(b.workspaceId))
    || String(a.botLabel ?? '~').localeCompare(String(b.botLabel ?? '~'))
    || a.rowId.localeCompare(b.rowId));
}

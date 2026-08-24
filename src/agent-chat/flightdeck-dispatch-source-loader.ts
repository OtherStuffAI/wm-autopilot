import { Database } from 'bun:sqlite';

import { FlightDeckPgClient, createBotIdentityFromSecret } from '../flightdeck-pg/client';
import { sourceLabelForFlightDeckChat } from './flightdeck-dispatch-metadata';
import {
  dispatchSourceKey,
  type DispatchSourceLabels,
  type HistoricalDispatchRow,
} from './flightdeck-dispatch-reconciler';
import type { FlightDeckPgMessage } from './tower-client';

interface SubscriptionSourceConfig {
  subscriptionId: string;
  workspaceId: string;
  backendBaseUrl: string;
  appNpub: string;
  botNpub: string;
}

export async function loadAuthoritativeFlightDeckSourceLabels(input: {
  databasePath: string;
  rows: HistoricalDispatchRow[];
  secretKey: Uint8Array;
  fetchImpl?: typeof fetch;
}): Promise<DispatchSourceLabels> {
  const labels = new Map<string, string>();
  const warnings: string[] = [];
  let requests = 0;
  const db = new Database(input.databasePath, { readonly: true });
  const configs = readSubscriptionConfigs(db);
  db.close();
  const botIdentity = createBotIdentityFromSecret(input.secretKey);

  for (const [subscriptionId, rows] of groupBySubscription(input.rows)) {
    const config = configs.get(subscriptionId);
    if (!config) {
      warnings.push(`No workspace subscription config exists for ${subscriptionId}; source labels retain the explicit fallback.`);
      continue;
    }
    if (config.botNpub !== botIdentity.botNpub) {
      warnings.push(`The active signer does not match subscription ${subscriptionId}; source labels retain the explicit fallback.`);
      continue;
    }
    const client = new FlightDeckPgClient({
      towerUrl: config.backendBaseUrl,
      wingmanUrl: '',
      appNpub: config.appNpub,
      botIdentity,
      fetchImpl: input.fetchImpl,
    });
    try {
      const result = await materialiseWorkspaceSources(client, config.workspaceId, rows);
      requests += result.requests;
      for (const [recordId, label] of result.labels) {
        labels.set(dispatchSourceKey(subscriptionId, recordId), label);
      }
    } catch (error) {
      warnings.push(`Source hydration failed for subscription ${subscriptionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { labels, warnings, requests };
}

async function materialiseWorkspaceSources(
  client: FlightDeckPgClient,
  workspaceId: string,
  rows: HistoricalDispatchRow[],
): Promise<{ labels: Map<string, string>; requests: number }> {
  const labels = new Map<string, string>();
  let requests = 1;
  const scopesResult = await client.listScopes(workspaceId) as { scopes?: Array<Record<string, unknown>> };
  const scopeIds = (scopesResult.scopes ?? []).map((scope) => text(scope.id)).filter((id): id is string => Boolean(id));
  const channelIds = new Set<string>();

  for (const scopeId of scopeIds) {
    requests += 1;
    const result = await client.listChannels(workspaceId, scopeId, 500);
    for (const channel of result.channels ?? []) {
      const channelId = text(channel.id);
      if (channelId) channelIds.add(channelId);
    }
  }

  const chatIds = new Set(rows.filter((row) => row.trigger === 'chat').map((row) => row.recordId));
  const taskIds = new Set(rows.filter((row) => row.trigger === 'task').map((row) => row.recordId));
  const docIds = new Set(rows.filter((row) => row.trigger === 'doc').map((row) => row.recordId));
  const messages: FlightDeckPgMessage[] = [];

  if (chatIds.size > 0) {
    for (const channelId of channelIds) {
      let cursor: string | null = null;
      do {
        requests += 1;
        const result = await client.listChannelMessages(workspaceId, channelId, { cursor, limit: 500 });
        messages.push(...result.messages);
        cursor = result.next_cursor;
      } while (cursor);
    }
    for (const message of messages) {
      if (!chatIds.has(message.id)) continue;
      labels.set(message.id, sourceLabelForFlightDeckChat({ message, messages }));
    }
  }

  if (taskIds.size > 0) {
    for (const scopeId of scopeIds) {
      requests += 1;
      const result = await client.listTasks(workspaceId, { scopeId, limit: 500 }) as { tasks?: Array<Record<string, unknown>> };
      for (const task of result.tasks ?? []) {
        const id = text(task.id);
        const title = text(task.title);
        if (id && title && taskIds.has(id)) labels.set(id, title);
      }
    }
  }

  if (docIds.size > 0) {
    for (const channelId of channelIds) {
      requests += 1;
      const result = await client.listDocs(workspaceId, channelId, 500) as { docs?: Array<Record<string, unknown>>; documents?: Array<Record<string, unknown>> };
      for (const doc of result.docs ?? result.documents ?? []) {
        const id = text(doc.id);
        const title = text(doc.title);
        if (id && title && docIds.has(id)) labels.set(id, title);
      }
    }
  }

  return { labels, requests };
}

function readSubscriptionConfigs(db: Database): Map<string, SubscriptionSourceConfig> {
  const rows = db.query(`SELECT subscription_id, workspace_id, backend_base_url, source_app_npub, bot_npub
    FROM workspace_subscriptions`).all() as Array<Record<string, unknown>>;
  const configs = new Map<string, SubscriptionSourceConfig>();
  for (const row of rows) {
    const subscriptionId = text(row.subscription_id);
    const workspaceId = text(row.workspace_id);
    const backendBaseUrl = text(row.backend_base_url);
    const appNpub = text(row.source_app_npub);
    const botNpub = text(row.bot_npub);
    if (!subscriptionId || !workspaceId || !backendBaseUrl || !appNpub || !botNpub) continue;
    configs.set(subscriptionId, { subscriptionId, workspaceId, backendBaseUrl, appNpub, botNpub });
  }
  return configs;
}

function groupBySubscription(rows: HistoricalDispatchRow[]): Map<string, HistoricalDispatchRow[]> {
  const groups = new Map<string, HistoricalDispatchRow[]>();
  for (const row of rows) {
    const group = groups.get(row.subscriptionId) ?? [];
    group.push(row);
    groups.set(row.subscriptionId, group);
  }
  return groups;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

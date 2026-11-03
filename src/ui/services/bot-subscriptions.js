// Per-bot Flight Deck delivery paths. Server rows are written to Dexie first; callers read back from Dexie.
let database;

async function botSubscriptionDb() {
  if (!database) {
    const { default: Dexie } = await import('/vendor/dexie/dexie.mjs');
    database = new Dexie('WingmanBotSubscriptions');
    database.version(1).stores({ rows: 'rowId, workspaceId, subscriptionId', classifications: 'subscriptionId' });
  }
  return database;
}

export class BotSubscriptionsUnavailableError extends Error {
  constructor() {
    super('Per-bot delivery status is not available on this Autopilot build yet.');
    this.name = 'BotSubscriptionsUnavailableError';
  }
}

export async function persistBotSubscriptionRows(rows, { db = null } = {}) {
  const target = db || await botSubscriptionDb();
  const syncedAt = Date.now();
  await target.transaction('rw', target.rows, async () => {
    // Server is the source of truth: retired delivery paths must disappear rather than linger as stale rows.
    await target.rows.clear();
    await target.rows.bulkPut(rows.map((row) => ({ ...row, syncedAt })));
  });
  return await target.rows.toArray();
}

export async function listBotSubscriptions({ fetchImpl = fetch, db = null } = {}) {
  const response = await fetchImpl('/api/agent-chat/bot-subscriptions', { credentials: 'include' });
  if (response.status === 404) throw new BotSubscriptionsUnavailableError();
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Failed to load per-bot delivery status');
  const rows = Array.isArray(payload.rows) ? payload.rows.filter((row) => row && typeof row.rowId === 'string') : [];
  return await persistBotSubscriptionRows(rows, { db });
}

/** Explicit, read-only Tower check of one bot's own classification. Never classifies. */
export async function readBotSubscriptionClassification(subscriptionId, { fetchImpl = fetch, db = null } = {}) {
  const response = await fetchImpl(`/api/agent-chat/subscriptions/${encodeURIComponent(subscriptionId)}/agent-inbox/classification`,
    { credentials: 'include' });
  const payload = await response.json().catch(() => ({}));
  const checkedAt = new Date().toISOString();
  const answered = response.ok && typeof payload.classified === 'boolean';
  const record = answered
    ? { subscriptionId, state: payload.classified ? 'classified' : 'unclassified', profile: payload.profile ?? null,
      checkedAt: payload.checkedAt || checkedAt, error: null }
    : { subscriptionId, state: 'error', profile: null, checkedAt,
      error: response.ok ? 'Tower returned no classification answer.'
        : response.status === 404 && !payload.error ? 'Classification check is not available on this Autopilot build yet.'
          : payload.error || 'Tower classification could not be read.' };
  const target = db || await botSubscriptionDb();
  await target.classifications.put(record);
  return await target.classifications.get(subscriptionId);
}

export async function listBotSubscriptionClassifications({ db = null } = {}) {
  const target = db || await botSubscriptionDb();
  return (await target.classifications.toArray()).map((record) => ({ ...record, cached: true }));
}

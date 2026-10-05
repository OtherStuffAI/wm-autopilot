let database;
async function optionsDatabase() {
  if (!database) {
    const { Dexie } = await import('../live/db.js');
    database = new Dexie('wingman-agent-enrichment');
    database.version(1).stores({ options: 'key' });
  }
  return database;
}

export async function loadAgentEnrichmentOptions() {
  const response = await fetch('/api/agent-chat/enrichment-options', { credentials: 'include' });
  // An older backend has no enrichment contract. The editor keeps Direct and
  // Pipeline Chooser until the operator activates the reviewed backend.
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Could not discover Agent Direct enrichment pipelines.');
  const payload = await response.json();
  const db = await optionsDatabase();
  await db.options.put({ key: 'catalogue', ...payload });
  return await db.options.get('catalogue');
}

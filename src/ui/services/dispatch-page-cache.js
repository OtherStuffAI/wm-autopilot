let database;

export async function persistDispatchPage(page, key) {
  if (!database) {
    const { Dexie } = await import('../live/db.js');
    database = new Dexie('WingmanFlightDeckDispatch');
    database.version(1).stores({ pages: 'key', outcomes: 'id' });
  }
  const ids = page.rows.map(row => row.id);
  await database.transaction('rw', database.pages, database.outcomes, async () => {
    await database.outcomes.bulkPut(page.rows);
    await database.pages.put({ key, ids, total: page.total, limit: page.limit, offset: page.offset });
  });
  const saved = await database.pages.get(key);
  return { rows: await database.outcomes.bulkGet(saved.ids), total: saved.total, limit: saved.limit, offset: saved.offset };
}

// Revision records share the IndexedDB transaction with message mutations.
// HTTP snapshots apply only if no SSE, optimistic or newer HTTP write intervened.
export function revisionKey(sessionId) {
  return `message-revision:${sessionId}`;
}

export async function readMessageRevision(db, sessionId) {
  return (await db.uiPreferences.get(revisionKey(sessionId)))?.value ?? 0;
}

export async function writeMessageRevision(db, sessionId) {
  const key = revisionKey(sessionId);
  const value = await readMessageRevision(db, sessionId) + 1;
  await db.uiPreferences.put({ key, value });
}

export function messageWrite(db, sessionId, operation) {
  return db.transaction("rw", db.messages, db.uiPreferences, async () => {
    const result = await operation();
    await writeMessageRevision(db, sessionId);
    return result;
  });
}

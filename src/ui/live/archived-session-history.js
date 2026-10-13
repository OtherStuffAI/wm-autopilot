import { db } from "./db.js";
import { fetchSessionHistoryApi } from "../services/sessions.js";

export async function loadArchivedSessionHistory(sessionId) {
  const data = await fetchSessionHistoryApi(sessionId);
  if (!data) {
    await db.sessionHistory.delete(sessionId);
    return null;
  }
  await db.sessionHistory.put({ sessionId, data, syncedAt: Date.now() });
  return (await db.sessionHistory.get(sessionId))?.data ?? null;
}

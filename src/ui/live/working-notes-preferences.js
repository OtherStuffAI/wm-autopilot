import { db, UiPreferenceStore } from "./db.js";

const PREFIX = "working-notes:";

export async function readWorkingNotesPreferences() {
  const rows = await db.uiPreferences.where("key").startsWith(PREFIX).toArray();
  return rows.map((row) => [row.key.slice(PREFIX.length), row.value === true]);
}

export function writeWorkingNotesPreference(key, open) {
  return UiPreferenceStore.set(`${PREFIX}${key}`, open);
}

type JsonRecord = Record<string, unknown>;

export interface SnapshotSaturation {
  collection: string;
  channelId: string | null;
  observedCount: number;
  possibleLimit: number;
}

/** Tower does not expose truncation flags for these bounded collections. */
export function snapshotSaturation(payload: JsonRecord): SnapshotSaturation[] {
  const findings: SnapshotSaturation[] = [];
  function inspect(collection: string, value: unknown, channelId: string | null): void {
    if (Array.isArray(value) && value.length >= 10_000) {
      findings.push({ collection, channelId, observedCount: value.length, possibleLimit: 10_000 });
    }
  }
  for (const collection of ["scopes", "channels", "daily_notes", "personal_wapps"]) {
    inspect(collection, payload[collection], null);
  }
  if (Array.isArray(payload.channel_bundles)) {
    for (const bundle of payload.channel_bundles as JsonRecord[]) {
      for (const collection of ["threads", "tasks", "task_comments", "docs", "doc_comments", "files", "file_folders", "audio_notes"]) {
        inspect(collection, bundle[collection], String(bundle.channel_id));
      }
    }
  }
  return findings;
}

import type { RecordSyncCache, Fence } from "./record-sync-cache.ts";

export function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive finite integer`);
  return value;
}
export function fence(cache: RecordSyncCache): Fence {
  const s = cache.state();
  return { cursor: s.cursor, clientId: s.clientId, generation: s.generation };
}

import type { CacheState } from "./record-sync-cache.ts";
import type { Page } from "./record-sync-protocol.ts";

/** Advertisement is not proof that a new family's historical rows were read. */
export function assertFamilyCompatibility(s: CacheState, p: Page, bounded: boolean): void {
  if (!s.families.length) return;
  const removed = s.families.filter((family) => !p.families.includes(family));
  const added = p.families.filter((family) => !s.families.includes(family));
  if (removed.length)
    throw new Error(`Advertised families removed: ${removed.join(", ")}; repair required`);
  if (added.length && (!bounded || !s.snapshotDone || p.mode !== "delta"))
    throw new Error(`Advertised families added outside bounded delta: ${added.join(", ")}; snapshot coverage repair required`);
  // Additive bounded deltas can retain new rows without rewinding the checkpoint.
  // Leave snapshot partitions unchanged: no delta certificate proves a bootstrap.
}

export function unfinishedFamilies(s: CacheState): string[] {
  return s.families.filter((family) => !s.partitions.includes(family));
}

import type { CacheState } from "./record-sync-cache.ts";
import type { Handover } from "./record-sync-protocol.ts";

/** Tower may extend an unfinished target when a new authority revision gains
 * readable partitions. Notifications can span pages; a grant need not be on
 * the page extending the target. Content writes alone cannot move it.
 */
export function assertHandoverProgress(s: CacheState, h: Handover): void {
  if (h.authority_epoch !== s.epoch)
    throw new Error("Handover authority epoch mismatch");
  if (s.target !== null && h.target_position !== s.target) {
    if (h.target_position === null || BigInt(h.target_position) < BigInt(s.target))
      throw new Error("Handover target regressed");
    const authorityAdvanced = s.accessRevision !== null &&
      BigInt(h.access_revision) > BigInt(s.accessRevision);
    if (!s.certified && !authorityAdvanced)
      throw new Error("Fixed handover target changed during traversal");
  }
  if (s.through !== null && BigInt(h.through_position) < BigInt(s.through))
    throw new Error("Handover position regressed");
  if (h.target_position !== null && BigInt(h.through_position) > BigInt(h.target_position))
    throw new Error("Handover position exceeds target");
}

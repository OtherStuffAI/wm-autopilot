import { normaliseNpub } from "../identity/npub-utils";
import { detectWorktree } from "./git-worktree-detector";
import { npubProjectStore, type NpubProjectRecord } from "./npub-project-store";

export async function trackProjectForSession(
  npub: string | undefined,
  directoryPath: string,
): Promise<NpubProjectRecord | null> {
  const normalized = normaliseNpub(npub ?? null);
  if (!normalized) {
    // Only track for authenticated users
    return null;
  }

  try {
    const worktreeInfo = await detectWorktree(directoryPath);

    const record = npubProjectStore.trackProject({
      npub: normalized,
      directoryPath,
      worktreeName: worktreeInfo.worktreeName,
      autoName: worktreeInfo.autoName,
    });

    console.log(
      `[project-tracker] Tracked project "${record.name}" for ${normalized.slice(0, 12)}... (count: ${record.sessionCount})`,
    );

    return record;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[project-tracker] Failed to track project: ${message}`);
    return null;
  }
}

import type { SecretInventory } from "./secret-routes";
import { validatedNpub } from "./secret-policy";

export interface SecretInventorySources {
  apps?: (owner: string) => Promise<Array<{ id: string; label: string; root: string; ownerNpub: string | null }>>;
  workspaces: (owner: string) => Array<{ workspaceId?: string | null; workspaceOwnerNpub: string; lifecycleStatus?: string }>;
  users: () => Array<{ npub: string; nickname?: string | null; profileName?: string | null }>;
  bots: (owner: string) => Array<{ botNpub: string; displayName: string }>;
  pipelines: (owner: string) => Promise<Array<{ id: string; name: string }>>;
}
export function createSecretInventory(sources: SecretInventorySources) {
  return async (owner: string): Promise<SecretInventory> => {
    const workspaces = [...new Set(sources.workspaces(owner).filter(row => row.workspaceOwnerNpub === owner && row.lifecycleStatus === "active")
      .map(row => row.workspaceId).filter((id): id is string => Boolean(id)))];
    const users = sources.users().map(row => ({ npub: validatedNpub(row.npub), label: row.nickname || row.profileName || row.npub, type: "user" as const }));
    const bots = sources.bots(owner).map(row => ({ npub: validatedNpub(row.botNpub), label: row.displayName, type: "bot" as const }));
    const apps = sources.apps ? (await sources.apps(owner)).filter(app => app.ownerNpub === owner)
      .map(({ id, label, root }) => ({ id, label, root })) : undefined;
    return { ...(apps ? { apps } : {}), workspaces: [{ id: "local", label: "Autopilot local" }, ...workspaces.map(id => ({ id, label: id }))],
      identities: [...users, ...bots], pipelines: (await sources.pipelines(owner)).map(row => ({ id: row.id, label: row.name })) };
  };
}

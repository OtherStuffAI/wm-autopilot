import { normaliseBackendBaseUrl } from "../agent-chat/tower-client";

interface BackendConnectionForWappPublish {
  backendBaseUrl: string;
  setupWorkspaceOwnerNpub: string | null;
  setupSourceAppNpub: string | null;
}

interface BackendConnectionSource {
  listAvailableForManagerNpub(npub: string): BackendConnectionForWappPublish[];
}

export type WappSourceAppNpubResolver = (input: {
  towerUrl: string;
  workspaceOwnerNpub: string;
  managerNpub: string;
}) => string | null;

export function createWappSourceAppNpubResolver(
  source: BackendConnectionSource,
): WappSourceAppNpubResolver {
  return ({ towerUrl, workspaceOwnerNpub, managerNpub }) => {
    const normalizedTowerUrl = normaliseBackendBaseUrl(towerUrl);
    const matches = source.listAvailableForManagerNpub(managerNpub).filter((connection) => (
      normaliseBackendBaseUrl(connection.backendBaseUrl) === normalizedTowerUrl
      && connection.setupWorkspaceOwnerNpub === workspaceOwnerNpub
      && Boolean(connection.setupSourceAppNpub)
    ));
    const sourceAppNpubs = [...new Set(matches.map((connection) => connection.setupSourceAppNpub!))];
    if (sourceAppNpubs.length > 1) {
      throw new Error("wapp-publish-ambiguous-flightdeck-app");
    }
    return sourceAppNpubs[0] ?? null;
  };
}

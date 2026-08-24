import { describe, expect, test } from "bun:test";

import { createWappSourceAppNpubResolver } from "./wapp-publish-target";

describe("WApp publish target resolution", () => {
  test("uses the exact Tower and workspace backend connection application identity", () => {
    const resolver = createWappSourceAppNpubResolver({
      listAvailableForManagerNpub: () => [{
        backendBaseUrl: "https://tower.example/",
        setupWorkspaceOwnerNpub: "npub1workspace",
        setupSourceAppNpub: "npub1flightdeck",
      }],
    });

    expect(resolver({
      towerUrl: "https://tower.example",
      workspaceOwnerNpub: "npub1workspace",
      managerNpub: "npub1manager",
    })).toBe("npub1flightdeck");
  });

  test("does not fall back across workspaces or ambiguous application identities", () => {
    const resolver = createWappSourceAppNpubResolver({
      listAvailableForManagerNpub: () => [
        {
          backendBaseUrl: "https://tower.example",
          setupWorkspaceOwnerNpub: "npub1workspace",
          setupSourceAppNpub: "npub1app1",
        },
        {
          backendBaseUrl: "https://tower.example",
          setupWorkspaceOwnerNpub: "npub1workspace",
          setupSourceAppNpub: "npub1app2",
        },
      ],
    });

    expect(() => resolver({
      towerUrl: "https://tower.example",
      workspaceOwnerNpub: "npub1workspace",
      managerNpub: "npub1manager",
    })).toThrow("wapp-publish-ambiguous-flightdeck-app");
    expect(resolver({
      towerUrl: "https://tower.example",
      workspaceOwnerNpub: "npub1other",
      managerNpub: "npub1manager",
    })).toBeNull();
  });
});

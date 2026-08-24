import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import { createNpubProjectApiHandler } from "./npub-project-api";
import type { NpubProjectRecord } from "./npub-project-store";

const ownerNpub = nip19.npubEncode(getPublicKey(generateSecretKey()));
const otherNpub = nip19.npubEncode(getPublicKey(generateSecretKey()));
const now = new Date().toISOString();

function record(overrides: Partial<NpubProjectRecord> = {}): NpubProjectRecord {
  return {
    id: "project-1",
    npub: ownerNpub,
    directoryPath: "/tmp/project-1",
    name: "Project 1",
    isCustomName: false,
    worktreeName: null,
    appId: null,
    taskBoardUrl: null,
    lastUsedAt: now,
    sessionCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeStore(project = record()) {
  let current: NpubProjectRecord | null = project;
  return {
    listByNpub: (npub: string) => current?.npub === npub ? [current] : [],
    createProject: (npub: string, directoryPath: string, name?: string) => record({ npub, directoryPath, name: name ?? "Project" }),
    getById: (id: string) => current?.id === id ? current : null,
    updateName: (_id: string, name: string) => current = current ? { ...current, name } : null,
    resetName: () => current,
    updateTaskBoardUrl: (_id: string, taskBoardUrl: string | null) => current = current ? { ...current, taskBoardUrl } : null,
    delete: () => { current = null; return true; },
  };
}

function auth(npub: string) {
  return { npub, actorNpub: npub, signerNpub: npub, session: null, authMethod: "nip98", delegatedByBot: false } as const;
}

describe("npub project ownership", () => {
  test("valid non-admin collection reads cannot select another npub", async () => {
    const handler = createNpubProjectApiHandler(makeStore());
    const url = new URL(`http://localhost/api/npub-projects?npub=${ownerNpub}`);
    const response = await handler(new Request(url.toString()), url, "GET", auth(otherNpub), false);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ projects: [] });
  });

  test.each(["GET", "PATCH", "DELETE"] as const)("valid non-admin %s cannot access another owner's object", async (method) => {
    const handler = createNpubProjectApiHandler(makeStore());
    const url = new URL("http://localhost/api/npub-projects/project-1");
    const response = await handler(new Request(url.toString(), {
      method,
      body: method === "PATCH" ? JSON.stringify({ name: "Stolen" }) : undefined,
    }), url, method, auth(otherNpub), false);
    expect(response?.status).toBe(403);
  });

  test("valid non-admin POST always creates under the signer identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "npub-project-owner-"));
    try {
      const store = makeStore();
      const handler = createNpubProjectApiHandler(store);
      const url = new URL("http://localhost/api/npub-projects");
      const response = await handler(new Request(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ directoryPath: directory, npub: ownerNpub }),
      }), url, "POST", auth(otherNpub), false);
      expect(response?.status).toBe(201);
      expect((await response?.json() as { project: { npub: string } }).project.npub).toBe(otherNpub);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each(["GET", "PATCH", "DELETE"] as const)("configured admin %s retains object access", async (method) => {
    const handler = createNpubProjectApiHandler(makeStore());
    const url = new URL("http://localhost/api/npub-projects/project-1");
    const response = await handler(new Request(url.toString(), {
      method,
      body: method === "PATCH" ? JSON.stringify({ name: "Admin update" }) : undefined,
    }), url, method, auth(otherNpub), true);
    expect(response?.status).toBe(200);
  });

  test("configured admin collection read may select another npub", async () => {
    const handler = createNpubProjectApiHandler(makeStore());
    const url = new URL(`http://localhost/api/npub-projects?npub=${ownerNpub}`);
    const response = await handler(new Request(url.toString()), url, "GET", auth(otherNpub), true);
    expect((await response?.json() as { projects: unknown[] }).projects).toHaveLength(1);
  });
});

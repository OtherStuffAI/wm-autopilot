import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { RequestAuthContext } from "../auth/request-context";
import { handleRemoteInstructApi, type RemoteInstructRoutesContext } from "./remote-instruct-routes";

const authenticatedAuth: RequestAuthContext = {
  npub: "npub1viewer",
  actorNpub: "npub1viewer",
  signerNpub: "npub1viewer",
  subjectNpub: "npub1viewer",
  targetOwnerNpub: "npub1viewer",
  session: null,
  authMethod: "nip98",
  delegatedByBot: false,
};

function makeContext(overrides: Partial<RemoteInstructRoutesContext> = {}): RemoteInstructRoutesContext {
  return {
    promptPath: join(import.meta.dir, "../../templates/remote-instruct.md"),
    config: {
      baseUrl: "http://localhost:3000",
      agents: {
        codex: { label: "Codex" },
        claude: { label: "Claude" },
      },
    },
    getDefaultWorkdir: () => "/workspace",
    projectReference: "Project X",
    resolveNip98AuthContext: async () => authenticatedAuth,
    ensureApiAccess: async () => null,
    ensureTemplateManageAccess: async () => null,
    AccessActions: {
      SessionsManage: "sessions:manage" as never,
    },
    ...overrides,
  };
}

describe("handleRemoteInstructApi", () => {
  test("returns null for unrelated routes", async () => {
    const url = new URL("http://localhost:3000/api/other");
    const response = await handleRemoteInstructApi(
      new Request(url),
      url,
      "GET",
      authenticatedAuth,
      makeContext(),
    );

    expect(response).toBeNull();
  });

  test("uses existing sessions access and returns rendered prompt", async () => {
    const url = new URL("http://localhost:3000/api/remote-instruct");
    const response = await handleRemoteInstructApi(
      new Request(url),
      url,
      "GET",
      authenticatedAuth,
      makeContext(),
    );
    const body = await response!.json() as {
      ok: boolean;
      name: string;
      content: string;
      variables: Record<string, string>;
    };

    expect(response!.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.name).toBe("Remote Instruct");
    expect(body.content).toContain("Project X");
    expect(body.content).toContain("/workspace");
    expect(body.variables.viewer_npub).toBe("npub1viewer");
  });

  test("returns the access response when sessions access is denied", async () => {
    const url = new URL("http://localhost:3000/api/remote-instruct");
    const response = await handleRemoteInstructApi(
      new Request(url),
      url,
      "GET",
      { ...authenticatedAuth, npub: null },
      makeContext({
        resolveNip98AuthContext: async (_request, _url, authContext) => authContext,
        ensureApiAccess: async () =>
          Response.json({ error: "Authentication required" }, { status: 401 }),
      }),
    );

    expect(response!.status).toBe(401);
  });

  test("returns method not allowed for writes", async () => {
    const url = new URL("http://localhost:3000/api/remote-instruct");
    const response = await handleRemoteInstructApi(
      new Request(url, { method: "POST" }),
      url,
      "POST",
      authenticatedAuth,
      makeContext(),
    );

    expect(response!.status).toBe(405);
    expect(response!.headers.get("allow")).toBe("GET");
  });

  test("returns the raw template for admin settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-instruct-test-"));
    try {
      const promptPath = join(root, "remote-instruct.md");
      await writeFile(promptPath, "Hello $hostname from $project_reference", "utf8");
      const url = new URL("http://localhost:3000/api/remote-instruct/template");
      const response = await handleRemoteInstructApi(
        new Request(url),
        url,
        "GET",
        authenticatedAuth,
        makeContext({ promptPath }),
      );
      const body = await response!.json() as {
        template: string;
        variables: Record<string, string>;
      };

      expect(response!.status).toBe(200);
      expect(body.template).toBe("Hello $hostname from $project_reference");
      expect(body.variables.project_reference).toBe("Project X");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("saves the raw template for admin settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-instruct-test-"));
    try {
      const promptPath = join(root, "remote-instruct.md");
      await writeFile(promptPath, "Old prompt", "utf8");
      const url = new URL("http://localhost:3000/api/remote-instruct/template");
      const response = await handleRemoteInstructApi(
        new Request(url, {
          method: "PUT",
          body: JSON.stringify({ template: "New $hostname prompt" }),
          headers: { "content-type": "application/json" },
        }),
        url,
        "PUT",
        authenticatedAuth,
        makeContext({ promptPath }),
      );
      const body = await response!.json() as { template: string };

      expect(response!.status).toBe(200);
      expect(body.template).toBe("New $hostname prompt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires admin access for raw template settings", async () => {
    const url = new URL("http://localhost:3000/api/remote-instruct/template");
    const response = await handleRemoteInstructApi(
      new Request(url),
      url,
      "GET",
      authenticatedAuth,
      makeContext({
        ensureTemplateManageAccess: async () =>
          Response.json({ error: "admin-only" }, { status: 403 }),
      }),
    );

    expect(response!.status).toBe(403);
  });
});

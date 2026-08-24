import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import type { RequestAuthContext } from "../auth/request-context";
import type { AppRecord } from "../apps/app-registry";
import { appCommand } from "../apps/app-command";
import { buildWappScopeAccessResolution, FlightDeckScopeAccessResolver, WappScopeAccessError } from "../wapps/scope-access";
import { WappStore } from "../wapps/wapp-store";
import { handleWappsApi, type WappsApiContext } from "./wapps-api-routes";

const authContext: RequestAuthContext = {
  npub: "npub1owner",
  actorNpub: "npub1owner",
  session: { id: "session-1" } as any,
  delegatedByBot: false,
};

const app: AppRecord = {
  id: "app-1",
  label: "Ops Board",
  root: "/tmp/app",
  scripts: { start: appCommand("bun", "src/server.ts") },
  tmuxSession: "ops-board",
  ownerNpub: "npub1owner",
  createdAt: "2026-05-14T00:00:00.000Z",
  updatedAt: "2026-05-14T00:00:00.000Z",
  webApp: true,
  webAppPort: 4100,
};

function makeContext(): {
  ctx: WappsApiContext;
  cleanup: () => void;
  published: unknown[];
  registrations: unknown[];
  rotationVerifications: unknown[];
  scopeMembers: Map<string, string[]>;
} {
  const dir = mkdtempSync(join(tmpdir(), "wapps-api-"));
  const published: unknown[] = [];
  const registrations: unknown[] = [];
  const rotationVerifications: unknown[] = [];
  const authoritySecret = generateSecretKey();
  const scopeMembers = new Map<string, string[]>([
    ["scope-1", ["npub1member", "npub1owner", " npub1member "]],
    ["scope-2", ["npub1other"]],
  ]);
  return {
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    published,
    registrations,
    rotationVerifications,
    scopeMembers,
    ctx: {
      adminNpub: null,
      viewerNpub: "npub1owner",
      sourceWingmanUrl: "http://localhost:3000",
      flightDeckAppNamespace: "npub1flightdeck",
      AccessActions: { AppsManage: "apps:manage" as any },
      ensureApiAccess: async () => null,
      ensureDirectory: async (root) => root,
      canAccessApp: (candidate) => candidate.ownerNpub === "npub1owner",
      appRegistry: {
        listApps: async () => [app],
        getApp: async (id) => id === app.id ? app : undefined,
      },
      appAliasRegistry: {
        getByAppId: async () => ({ alias: "ops-board" }),
      },
      wappStore: new WappStore(join(dir, "wapps.sqlite")),
      publisher: {
        publish: async (payload) => {
          published.push(payload);
          return { published: true, reference: "flightdeck-pg:wapp:v1" };
        },
      },
      scopeAccessResolver: {
        resolveWappScopeAccess: async (input) => {
          if (!scopeMembers.has(input.scopeId)) {
            throw new WappScopeAccessError("invalid-scope", `Unknown scope ${input.scopeId}`);
          }
          return buildWappScopeAccessResolution({
            ...input,
            scopeLineage: {
              scopeId: input.scopeId,
              l1Id: input.scopeId === "scope-2" ? "l1-next" : "l1",
              l2Id: null,
              l3Id: null,
              l4Id: null,
              l5Id: null,
            },
            memberNpubs: scopeMembers.get(input.scopeId),
          });
        },
      },
      towerRegistrationIdentity: {
        botNpub: nip19.npubEncode(getPublicKey(authoritySecret)),
        botPubkeyHex: getPublicKey(authoritySecret),
        botSecret: authoritySecret,
      },
      towerWappRegistrar: {
        register: async (input) => {
          registrations.push(input);
          return { workspaceOwnerNpub: input.workspaceOwnerNpub, appNpub: input.appNpub, app: { app_npub: input.appNpub } };
        },
      },
      publisherRotationVerifier: async (input) => {
        rotationVerifications.push(input);
      },
      buildLaunchUrl: (alias) => `http://localhost:3000/host/${alias}`,
    },
  };
}

describe("handleWappsApi", () => {
  test("publishes Book of Sand-shaped activity only for the bound capability session", async () => {
    const { ctx, cleanup } = makeContext();
    try {
      const record = ctx.wappStore.create({
        id: "book-of-sand",
        appId: app.id,
        title: "Book of Sand",
        ownerNpub: "npub1owner",
        createdByNpub: "npub1owner",
        workspaceOwnerNpub: "npub1owner",
        scopeId: "scope-1",
        allowedNpubs: ["npub1owner"],
        launchUrl: "https://book.example",
      });
      let appsManageChecks = 0;
      ctx.ensureApiAccess = async () => {
        appsManageChecks += 1;
        return Response.json({ error: "admin-or-execution-delegation-required" }, { status: 403 });
      };
      ctx.hasWappActivityAuthority = (requestAuth, installationId) =>
        requestAuth.capabilitySessionId === "scheduled-session" && installationId === record.id;
      ctx.publishActivity = async (_wapp, projection) => ({
        grant: { wapp_installation_id: record.id, status: "active", capabilities: ["activity.publish"] },
        published: { item_id: "feed-item-1", external_id: projection.external_id },
      });
      const projection = {
        external_id: "book-of-sand:story:ocean-stratum",
        version: 1,
        scope_id: "scope-1",
        channel_id: "feed",
        category: "ai",
        title: "Ocean stratum",
        summary: "A verified material update.",
        occurred_at: "2026-08-11T07:15:00.000Z",
        priority: "normal",
        state: "active",
        open_url: "https://book.example/stories/ocean-stratum",
      };
      const requestAuth = { ...authContext, authMethod: "nip98" as const, capabilitySessionId: "scheduled-session" };
      const readRequest = new Request(`http://localhost:3000/api/wapps/${record.id}`);
      const read = await handleWappsApi(readRequest, new URL(readRequest.url), "GET", requestAuth, ctx);
      expect(read?.status).toBe(200);

      const rotateRequest = new Request(`http://localhost:3000/api/wapps/${record.id}/rotate-publisher-key`, {
        method: "POST",
        body: JSON.stringify({ confirmWappInstallationId: record.id, phase: "stage" }),
      });
      const rotate = await handleWappsApi(rotateRequest, new URL(rotateRequest.url), "POST", requestAuth, ctx);
      expect(rotate?.status).toBe(400);
      expect(await rotate!.json()).toEqual({ error: "WApp is not Tower-backed" });

      const request = new Request(`http://localhost:3000/api/wapps/${record.id}/activity`, {
        method: "POST",
        body: JSON.stringify(projection),
      });
      const response = await handleWappsApi(request, new URL(request.url), "POST", requestAuth, ctx);
      expect(response?.status).toBe(200);
      expect(await response!.json()).toMatchObject({ published: { external_id: projection.external_id } });
      expect(appsManageChecks).toBe(0);

      for (const [url, method] of [
        ["http://localhost:3000/api/wapps/another-installation/activity", "POST"],
        ["http://localhost:3000/api/wapps/book-of-sand/activity", "POST"],
      ] as const) {
        const deniedAuth = url.includes("another-installation") ? requestAuth : { ...requestAuth, capabilitySessionId: null };
        const deniedRequest = new Request(url, { method, body: JSON.stringify(projection) });
        const denied = await handleWappsApi(deniedRequest, new URL(url), method, deniedAuth, ctx);
        expect(denied?.status).toBe(403);
        expect(await denied!.json()).toEqual({ error: "wapp-activity-authority-required" });
      }

      const managementRequest = new Request(`http://localhost:3000/api/wapps/${record.id}`, { method: "PATCH", body: "{}" });
      const management = await handleWappsApi(managementRequest, new URL(managementRequest.url), "PATCH", requestAuth, ctx);
      expect(management?.status).toBe(403);
      expect(appsManageChecks).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("keeps Tower inactive-grant denial authoritative", async () => {
    const { ctx, cleanup } = makeContext();
    try {
      const record = ctx.wappStore.create({ id: "book-of-sand", appId: app.id, title: "Book of Sand", ownerNpub: "npub1owner", createdByNpub: "npub1owner", workspaceOwnerNpub: "npub1owner", scopeId: "scope-1", allowedNpubs: ["npub1owner"], launchUrl: "https://book.example" });
      ctx.hasWappActivityAuthority = () => true;
      ctx.publishActivity = async () => { throw Object.assign(new Error("publishing_grant_disabled"), { status: 403 }); };
      const request = new Request(`http://localhost:3000/api/wapps/${record.id}/activity`, { method: "POST", body: "{}" });
      const response = await handleWappsApi(request, new URL(request.url), "POST", authContext, ctx);
      expect(response?.status).toBe(403);
      expect(await response!.json()).toEqual({ error: "publishing_grant_disabled" });
    } finally {
      cleanup();
    }
  });

  test("creates Tower bindings and Tower-backed WApps without exposing WAPP_NSEC by default", async () => {
    const { ctx, cleanup, registrations } = makeContext();
    try {
      const secret = generateSecretKey();
      const appNsec = nip19.nsecEncode(secret);
      const appNpub = nip19.npubEncode(getPublicKey(secret));
      const bindingRequest = new Request("http://localhost:3000/api/wapps/tower-bindings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "tower-dev",
          label: "Tower Dev",
          towerUrl: "https://tower.example",
          workspaceOwnerNpub: "npub1workspace",
          userAlias: "tester",
          isDefault: true,
        }),
      });
      const bindingResponse = await handleWappsApi(bindingRequest, new URL(bindingRequest.url), "POST", authContext, ctx);
      expect(bindingResponse?.status).toBe(201);

      const createRequest = new Request("http://localhost:3000/api/wapps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: "app-1",
          title: "Ops Board",
          workspaceOwnerNpub: "npub1workspace",
          scopeId: "scope-1",
          towerBindingId: "tower-dev",
          appKeyMode: "import",
          wappNsec: appNsec,
          registeredOpenOrigins: ["https://wapp.example"],
        }),
      });
      const createResponse = await handleWappsApi(createRequest, new URL(createRequest.url), "POST", authContext, ctx);
      expect(createResponse?.status).toBe(201);
      const created = await createResponse!.json() as any;
      expect(created.wapp).toMatchObject({
        wappInstallationId: created.wapp.id,
        towerBindingId: "tower-dev",
        appNpub,
        publisherNpub: appNpub,
        registeredOpenOrigins: ["https://wapp.example"],
        towerBinding: { id: "tower-dev", towerUrl: "https://tower.example" },
      });
      expect(registrations).toHaveLength(1);
      expect(registrations[0]).toMatchObject({
        towerUrl: "https://tower.example",
        workspaceOwnerNpub: "npub1workspace",
        appNpub,
        appName: "Ops Board",
      });
      expect(JSON.stringify(created)).not.toContain(appNsec);
      expect(await ctx.wappStore.withAppSigningKey(created.wapp.id, (nsec) => nsec)).toBe(appNsec);

      const revealRequest = new Request(`http://localhost:3000/api/wapps/${created.wapp.id}/nsec`);
      const revealResponse = await handleWappsApi(revealRequest, new URL(revealRequest.url), "GET", authContext, ctx);
      expect(revealResponse?.status).toBe(410);
      expect(await revealResponse!.json()).toMatchObject({
        error: "wapp-secret-not-exportable",
      });
      expect(JSON.stringify(await (await handleWappsApi(revealRequest, new URL(revealRequest.url), "GET", authContext, ctx))!.json())).not.toContain(appNsec);
    } finally {
      cleanup();
    }
  });

  test("rotates a publisher key only through confirmed installation identity", async () => {
    const { ctx, cleanup, registrations, rotationVerifications } = makeContext();
    try {
      ctx.wappStore.createTowerBinding({
        id: "tower-dev",
        label: "Tower Dev",
        towerUrl: "https://tower.example",
        workspaceId: "workspace-1",
        workspaceOwnerNpub: "npub1workspace",
      });
      const originalNsec = nip19.nsecEncode(generateSecretKey());
      const record = ctx.wappStore.create({
        id: "installation-1",
        appId: "app-1",
        title: "Ops Board",
        ownerNpub: "npub1owner",
        createdByNpub: "npub1owner",
        workspaceOwnerNpub: "npub1workspace",
        scopeId: "scope-1",
        allowedNpubs: ["npub1owner"],
        launchUrl: "https://wapp.example/app",
        towerBindingId: "tower-dev",
        appKeyMode: "import",
        appNsec: originalNsec,
      });
      const rejectedRequest = new Request(`http://localhost:3000/api/wapps/${record.id}/rotate-publisher-key`, {
        method: "POST",
        body: JSON.stringify({ confirmWappInstallationId: "wrong", appKeyMode: "generate" }),
      });
      expect((await handleWappsApi(rejectedRequest, new URL(rejectedRequest.url), "POST", authContext, ctx))?.status).toBe(400);

      const replacementNsec = nip19.nsecEncode(generateSecretKey());
      const replacementNpub = nip19.npubEncode(getPublicKey((nip19.decode(replacementNsec) as any).data));
      const rotateRequest = new Request(`http://localhost:3000/api/wapps/${record.id}/rotate-publisher-key`, {
        method: "POST",
        body: JSON.stringify({
          confirmWappInstallationId: record.id,
          appKeyMode: "import",
          wappNsec: replacementNsec,
        }),
      });
      const response = await handleWappsApi(rotateRequest, new URL(rotateRequest.url), "POST", authContext, ctx);
      expect(response?.status).toBe(200);
      const payload = await response!.json() as any;
      expect(payload.wapp).toMatchObject({
        id: "installation-1",
        wappInstallationId: "installation-1",
        appNpub: record.appNpub,
        publisherNpub: record.publisherNpub,
        pendingPublisherNpub: replacementNpub,
      });
      expect(JSON.stringify(payload)).not.toContain(replacementNsec);
      expect(registrations).toHaveLength(0);

      const activateRequest = new Request(`http://localhost:3000/api/wapps/${record.id}/rotate-publisher-key`, {
        method: "POST",
        body: JSON.stringify({
          confirmWappInstallationId: record.id,
          phase: "activate",
        }),
      });
      ctx.publisherRotationVerifier = async () => {
        throw new Error("Tower has not approved the pending publisher key");
      };
      const blockedResponse = await handleWappsApi(activateRequest, new URL(activateRequest.url), "POST", authContext, ctx);
      expect(blockedResponse?.status).toBe(400);
      expect(ctx.wappStore.get(record.id)).toMatchObject({
        publisherNpub: record.publisherNpub,
        pendingPublisherNpub: replacementNpub,
      });
      ctx.publisherRotationVerifier = async (input) => {
        rotationVerifications.push(input);
      };
      const approvedActivateRequest = new Request(activateRequest.url, {
        method: "POST",
        body: JSON.stringify({
          confirmWappInstallationId: record.id,
          phase: "activate",
        }),
      });
      const activateResponse = await handleWappsApi(
        approvedActivateRequest,
        new URL(approvedActivateRequest.url),
        "POST",
        authContext,
        ctx,
      );
      expect(activateResponse?.status).toBe(200);
      const activated = await activateResponse!.json() as any;
      expect(activated.wapp).toMatchObject({
        id: "installation-1",
        publisherNpub: replacementNpub,
        pendingPublisherNpub: null,
      });
      expect(rotationVerifications).toHaveLength(1);
      expect(registrations).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("rejects Tower app key replacement on existing WApps", async () => {
    const { ctx, cleanup } = makeContext();
    try {
      const secret = generateSecretKey();
      const appNsec = nip19.nsecEncode(secret);
      const appNpub = nip19.npubEncode(getPublicKey(secret));
      const replacementNsec = nip19.nsecEncode(generateSecretKey());
      ctx.wappStore.createTowerBinding({
        id: "tower-dev",
        label: "Tower Dev",
        towerUrl: "https://tower.example",
        workspaceOwnerNpub: "npub1workspace",
      });
      const createRequest = new Request("http://localhost:3000/api/wapps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: "app-1",
          title: "Ops Board",
          workspaceOwnerNpub: "npub1workspace",
          scopeId: "scope-1",
          towerBindingId: "tower-dev",
          appKeyMode: "import",
          wappNsec: appNsec,
        }),
      });
      const createResponse = await handleWappsApi(createRequest, new URL(createRequest.url), "POST", authContext, ctx);
      const created = await createResponse!.json() as any;

      const regenerateRequest = new Request(`http://localhost:3000/api/wapps/${created.wapp.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appKeyMode: "generate" }),
      });
      const regenerateResponse = await handleWappsApi(regenerateRequest, new URL(regenerateRequest.url), "PATCH", authContext, ctx);
      expect(regenerateResponse?.status).toBe(400);
      expect(await regenerateResponse!.json()).toMatchObject({
        error: "WApp app key replacement is not supported for existing assignments",
      });

      const importRequest = new Request(`http://localhost:3000/api/wapps/${created.wapp.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appKeyMode: "import", wappNsec: replacementNsec }),
      });
      const importResponse = await handleWappsApi(importRequest, new URL(importRequest.url), "PATCH", authContext, ctx);
      expect(importResponse?.status).toBe(400);
      expect(ctx.wappStore.get(created.wapp.id)?.appNpub).toBe(appNpub);
      expect(await ctx.wappStore.withAppSigningKey(created.wapp.id, (nsec) => nsec)).toBe(appNsec);
    } finally {
      cleanup();
    }
  });

  test("registers existing Tower app npub when updating Tower binding", async () => {
    const { ctx, cleanup, registrations } = makeContext();
    try {
      const secret = generateSecretKey();
      const appNsec = nip19.nsecEncode(secret);
      const appNpub = nip19.npubEncode(getPublicKey(secret));
      ctx.wappStore.createTowerBinding({
        id: "tower-dev",
        label: "Tower Dev",
        towerUrl: "https://tower-dev.example",
        workspaceOwnerNpub: "npub1workspace",
      });
      ctx.wappStore.createTowerBinding({
        id: "tower-stage",
        label: "Tower Stage",
        towerUrl: "https://tower-stage.example",
        workspaceOwnerNpub: "npub1workspace",
      });
      const createRequest = new Request("http://localhost:3000/api/wapps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: "app-1",
          title: "Ops Board",
          workspaceOwnerNpub: "npub1workspace",
          scopeId: "scope-1",
          towerBindingId: "tower-dev",
          appKeyMode: "import",
          wappNsec: appNsec,
        }),
      });
      const createResponse = await handleWappsApi(createRequest, new URL(createRequest.url), "POST", authContext, ctx);
      const created = await createResponse!.json() as any;
      registrations.length = 0;

      const updateRequest = new Request(`http://localhost:3000/api/wapps/${created.wapp.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ towerBindingId: "tower-stage" }),
      });
      const updateResponse = await handleWappsApi(updateRequest, new URL(updateRequest.url), "PATCH", authContext, ctx);
      expect(updateResponse?.status).toBe(200);
      const updated = await updateResponse!.json() as any;
      expect(updated.wapp).toMatchObject({ towerBindingId: "tower-stage", appNpub });
      expect(registrations).toHaveLength(1);
      expect(registrations[0]).toMatchObject({
        towerUrl: "https://tower-stage.example",
        workspaceOwnerNpub: "npub1workspace",
        appNpub,
      });
    } finally {
      cleanup();
    }
  });

  test("returns a clear error when Tower app registration fails", async () => {
    const { ctx, cleanup } = makeContext();
    try {
      ctx.wappStore.createTowerBinding({
        id: "tower-dev",
        label: "Tower Dev",
        towerUrl: "https://tower.example",
        workspaceOwnerNpub: "npub1workspace",
      });
      ctx.towerWappRegistrar = {
        register: async () => {
          throw new Error("Tower registration failed: Not authorized to manage this workspace");
        },
      };
      const createRequest = new Request("http://localhost:3000/api/wapps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: "app-1",
          title: "Ops Board",
          workspaceOwnerNpub: "npub1workspace",
          scopeId: "scope-1",
          towerBindingId: "tower-dev",
          appKeyMode: "generate",
        }),
      });
      const createResponse = await handleWappsApi(createRequest, new URL(createRequest.url), "POST", authContext, ctx);
      expect(createResponse?.status).toBe(502);
      expect(await createResponse!.json()).toMatchObject({
        error: "wapp-tower-registration-failed",
        message: "Tower registration failed: Not authorized to manage this workspace",
      });
      expect(ctx.wappStore.list()).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("creates and refreshes WApp allowlists from resolved scope members", async () => {
    const { ctx, cleanup, published } = makeContext();
    try {
      const createRequest = new Request("http://localhost:3000/api/wapps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: "app-1",
          title: "Ops Board",
          workspaceOwnerNpub: "npub1workspace",
          scopeId: "scope-1",
          allowedNpubs: ["npub1malicious"],
          schedule: {
            timezone: "UTC",
            windows: [{ days: [1, 2, 3, 4, 5], start_time: "06:00", end_time: "12:00" }],
          },
        }),
      });
      const createResponse = await handleWappsApi(createRequest, new URL(createRequest.url), "POST", authContext, ctx);
      expect(createResponse?.status).toBe(201);
      const created = await createResponse!.json() as any;
      expect(created.wapp.allowedNpubs).toEqual(["npub1member", "npub1owner"]);
      expect(created.wapp.status).toBe("active");
      expect(created.wapp.schedule).toMatchObject({
        timezone: "UTC",
        windows: [{ days: [1, 2, 3, 4, 5], startTime: "06:00", endTime: "12:00" }],
      });

      const refreshRequest = new Request(`http://localhost:3000/api/wapps/${created.wapp.id}/refresh-allowlist`, {
        method: "POST",
        body: JSON.stringify({ allowedNpubs: ["npub1malicious"] }),
      });
      ctx.scopeAccessResolver.resolveWappScopeAccess = async (input) => buildWappScopeAccessResolution({
        ...input,
        memberNpubs: ["npub1other", "npub1owner", "npub1other"],
      });
      const refreshResponse = await handleWappsApi(refreshRequest, new URL(refreshRequest.url), "POST", authContext, ctx);
      const refreshed = await refreshResponse!.json() as any;
      expect(refreshed.wapp.allowedNpubs).toEqual(["npub1other", "npub1owner"]);
      expect(refreshed.wapp.scopeLineage.scopeId).toBe("scope-1");

      const publishRequest = new Request(`http://localhost:3000/api/wapps/${created.wapp.id}/publish`, { method: "POST" });
      const publishResponse = await handleWappsApi(publishRequest, new URL(publishRequest.url), "POST", authContext, ctx);
      expect(publishResponse?.status).toBe(200);
      expect(published).toHaveLength(1);
      expect((published[0] as any).data.schedule.windows[0]).toEqual({
        days: [1, 2, 3, 4, 5],
        start_time: "06:00",
        end_time: "12:00",
      });
    } finally {
      cleanup();
    }
  });

  test("creates WApp allowlist from yoke scope groups and cached group members", async () => {
    const { ctx, cleanup } = makeContext();
    try {
      ctx.scopeAccessResolver = new FlightDeckScopeAccessResolver(async () => ({
        record_id: "scope-yoke",
        owner_npub: "npub1workspace",
        l1_id: "l1-yoke",
        l2_id: "l2-yoke",
        group_ids: ["group-1"],
        shares: [{ type: "group", group_id: "group-1", access: "write" }],
        accessGroups: [{
          group_id: "group-1",
          current_group_npub: "npub1groupcurrent",
          member_npubs_json: JSON.stringify(["npub1member", "npub1other", "npub1member"]),
        }],
      }));
      const createRequest = new Request("http://localhost:3000/api/wapps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: "app-1",
          title: "Ops Board",
          workspaceOwnerNpub: "npub1workspace",
          scopeId: "scope-yoke",
          allowedNpubs: ["npub1malicious"],
          scopeLineage: { l1Id: "request-lineage" },
        }),
      });
      const createResponse = await handleWappsApi(createRequest, new URL(createRequest.url), "POST", authContext, ctx);
      expect(createResponse?.status).toBe(201);
      const created = await createResponse!.json() as any;
      expect(created.wapp.allowedNpubs).toEqual(["npub1member", "npub1other", "npub1owner"]);
      expect(created.wapp.scopeLineage).toMatchObject({ scopeId: "scope-yoke", l1Id: "l1-yoke", l2Id: "l2-yoke" });
    } finally {
      cleanup();
    }
  });

  test("rejects yoke scopes owned by a different workspace", async () => {
    const { ctx, cleanup } = makeContext();
    try {
      ctx.scopeAccessResolver = new FlightDeckScopeAccessResolver(async () => ({
        record_id: "scope-yoke",
        owner_npub: "npub1differentworkspace",
        group_ids: [],
        member_npubs: ["npub1member"],
      }));
      const request = new Request("http://localhost:3000/api/wapps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: "app-1",
          title: "Ops Board",
          workspaceOwnerNpub: "npub1workspace",
          scopeId: "scope-yoke",
        }),
      });
      const response = await handleWappsApi(request, new URL(request.url), "POST", authContext, ctx);
      expect(response?.status).toBe(400);
      expect(await response!.json()).toMatchObject({ error: "invalid-scope" });
    } finally {
      cleanup();
    }
  });

  test("updates scope access from resolver instead of request allowlist", async () => {
    const { ctx, cleanup } = makeContext();
    try {
      const createRequest = new Request("http://localhost:3000/api/wapps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: "app-1",
          title: "Ops Board",
          workspaceOwnerNpub: "npub1workspace",
          scopeId: "scope-1",
        }),
      });
      const createResponse = await handleWappsApi(createRequest, new URL(createRequest.url), "POST", authContext, ctx);
      const created = await createResponse!.json() as any;

      const updateRequest = new Request(`http://localhost:3000/api/wapps/${created.wapp.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scopeId: "scope-2",
          allowedNpubs: ["npub1malicious"],
        }),
      });
      const updateResponse = await handleWappsApi(updateRequest, new URL(updateRequest.url), "PATCH", authContext, ctx);
      expect(updateResponse?.status).toBe(200);
      const updated = await updateResponse!.json() as any;
      expect(updated.wapp.scopeId).toBe("scope-2");
      expect(updated.wapp.scopeLineage.l1Id).toBe("l1-next");
      expect(updated.wapp.allowedNpubs).toEqual(["npub1other", "npub1owner"]);
    } finally {
      cleanup();
    }
  });

  test("patch refreshes unchanged scope access and ignores request lineage authority", async () => {
    const { ctx, cleanup, scopeMembers } = makeContext();
    try {
      const createRequest = new Request("http://localhost:3000/api/wapps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: "app-1",
          title: "Ops Board",
          workspaceOwnerNpub: "npub1workspace",
          scopeId: "scope-1",
        }),
      });
      const createResponse = await handleWappsApi(createRequest, new URL(createRequest.url), "POST", authContext, ctx);
      const created = await createResponse!.json() as any;
      scopeMembers.set("scope-1", ["npub1other"]);

      const updateRequest = new Request(`http://localhost:3000/api/wapps/${created.wapp.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          allowedNpubs: ["npub1malicious"],
          scopeLineage: { scopeId: "scope-1", l1Id: "request-lineage" },
        }),
      });
      const updateResponse = await handleWappsApi(updateRequest, new URL(updateRequest.url), "PATCH", authContext, ctx);
      expect(updateResponse?.status).toBe(200);
      const updated = await updateResponse!.json() as any;
      expect(updated.wapp.scopeId).toBe("scope-1");
      expect(updated.wapp.scopeLineage.l1Id).toBe("l1");
      expect(updated.wapp.allowedNpubs).toEqual(["npub1other", "npub1owner"]);
    } finally {
      cleanup();
    }
  });

  test("rejects unknown scope input on create", async () => {
    const { ctx, cleanup } = makeContext();
    try {
      const request = new Request("http://localhost:3000/api/wapps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: "app-1",
          title: "Ops Board",
          workspaceOwnerNpub: "npub1workspace",
          scopeId: "missing-scope",
          allowedNpubs: ["npub1malicious"],
        }),
      });
      const response = await handleWappsApi(request, new URL(request.url), "POST", authContext, ctx);
      expect(response?.status).toBe(400);
      expect(await response!.json()).toMatchObject({ error: "invalid-scope" });
    } finally {
      cleanup();
    }
  });

  test("rejects grouped scopes when group membership cannot be resolved", async () => {
    const { ctx, cleanup } = makeContext();
    try {
      ctx.scopeAccessResolver = new FlightDeckScopeAccessResolver(async () => ({
        record_id: "scope-yoke",
        workspace_owner_npub: "npub1workspace",
        l1_id: "l1-yoke",
        group_ids: ["missing-group"],
        shares: [{ type: "group", group_id: "missing-group", access: "write" }],
        accessGroups: [],
      }));
      const request = new Request("http://localhost:3000/api/wapps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: "app-1",
          title: "Ops Board",
          workspaceOwnerNpub: "npub1workspace",
          scopeId: "scope-yoke",
        }),
      });
      const response = await handleWappsApi(request, new URL(request.url), "POST", authContext, ctx);
      expect(response?.status).toBe(400);
      expect(await response!.json()).toMatchObject({ error: "unresolvable-scope" });
    } finally {
      cleanup();
    }
  });

  test("does not stamp lastPublishedAt when publish transport is unavailable", async () => {
    const { ctx, cleanup } = makeContext();
    try {
      ctx.publisher = {
        publish: async () => ({ published: false, error: "wapp-publish-transport-unavailable", status: 503 }),
      };
      const createRequest = new Request("http://localhost:3000/api/wapps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: "app-1",
          title: "Ops Board",
          workspaceOwnerNpub: "npub1workspace",
          scopeId: "scope-1",
        }),
      });
      const createResponse = await handleWappsApi(createRequest, new URL(createRequest.url), "POST", authContext, ctx);
      const created = await createResponse!.json() as any;
      const publishRequest = new Request(`http://localhost:3000/api/wapps/${created.wapp.id}/publish`, { method: "POST" });
      const publishResponse = await handleWappsApi(publishRequest, new URL(publishRequest.url), "POST", authContext, ctx);
      expect(publishResponse?.status).toBe(503);
      expect(ctx.wappStore.get(created.wapp.id)?.lastPublishedAt).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("deletes WApps by publishing a deleted Flight Deck record", async () => {
    const { ctx, cleanup, published } = makeContext();
    try {
      const createRequest = new Request("http://localhost:3000/api/wapps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: "app-1",
          title: "Ops Board",
          workspaceOwnerNpub: "npub1workspace",
          scopeId: "scope-1",
        }),
      });
      const createResponse = await handleWappsApi(createRequest, new URL(createRequest.url), "POST", authContext, ctx);
      const created = await createResponse!.json() as any;
      published.length = 0;

      const deleteRequest = new Request(`http://localhost:3000/api/wapps/${created.wapp.id}`, { method: "DELETE" });
      const deleteResponse = await handleWappsApi(deleteRequest, new URL(deleteRequest.url), "DELETE", authContext, ctx);
      const deleted = await deleteResponse!.json() as any;

      expect(deleteResponse?.status).toBe(200);
      expect(deleted.wapp.recordState).toBe("deleted");
      expect(ctx.wappStore.get(created.wapp.id)?.recordState).toBe("deleted");
      expect(published).toHaveLength(1);
      expect((published[0] as any).record_id).toBe(created.wapp.id);
      expect((published[0] as any).data.record_state).toBe("deleted");
    } finally {
      cleanup();
    }
  });

  test("archives WApps by publishing an archived Flight Deck record", async () => {
    const { ctx, cleanup, published } = makeContext();
    try {
      const createRequest = new Request("http://localhost:3000/api/wapps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: "app-1",
          title: "Ops Board",
          workspaceOwnerNpub: "npub1workspace",
          scopeId: "scope-1",
        }),
      });
      const createResponse = await handleWappsApi(createRequest, new URL(createRequest.url), "POST", authContext, ctx);
      const created = await createResponse!.json() as any;
      published.length = 0;

      const archiveRequest = new Request(`http://localhost:3000/api/wapps/${created.wapp.id}/archive`, { method: "POST" });
      const archiveResponse = await handleWappsApi(archiveRequest, new URL(archiveRequest.url), "POST", authContext, ctx);
      const archived = await archiveResponse!.json() as any;

      expect(archiveResponse?.status).toBe(200);
      expect(archived.wapp.status).toBe("archived");
      expect(archived.wapp.recordState).toBe("archived");
      expect(published).toHaveLength(1);
      expect((published[0] as any).data.status).toBe("archived");
      expect((published[0] as any).data.record_state).toBe("archived");
    } finally {
      cleanup();
    }
  });

  test("keeps WApp active when delete tombstone publication fails", async () => {
    const { ctx, cleanup } = makeContext();
    try {
      ctx.publisher = {
        publish: async () => ({ published: false, error: "wapp-publish-transport-unavailable", status: 503 }),
      };
      const createRequest = new Request("http://localhost:3000/api/wapps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appId: "app-1",
          title: "Ops Board",
          workspaceOwnerNpub: "npub1workspace",
          scopeId: "scope-1",
        }),
      });
      const createResponse = await handleWappsApi(createRequest, new URL(createRequest.url), "POST", authContext, ctx);
      const created = await createResponse!.json() as any;

      const deleteRequest = new Request(`http://localhost:3000/api/wapps/${created.wapp.id}`, { method: "DELETE" });
      const deleteResponse = await handleWappsApi(deleteRequest, new URL(deleteRequest.url), "DELETE", authContext, ctx);

      expect(deleteResponse?.status).toBe(503);
      expect(ctx.wappStore.get(created.wapp.id)?.recordState).toBe("active");
    } finally {
      cleanup();
    }
  });

  test("rejects WApp template creation in non-empty roots unless forced", async () => {
    const { ctx, cleanup } = makeContext();
    try {
      const root = mkdtempSync(join(tmpdir(), "wapp-template-existing-"));
      writeFileSync(join(root, "package.json"), "{}\n");
      const request = new Request("http://localhost:3000/api/wapps/templates/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ root }),
      });
      const response = await handleWappsApi(request, new URL(request.url), "POST", authContext, ctx);
      expect(response?.status).toBe(400);
      expect(((await response!.json()) as { error: string }).error).toContain("not empty");

      const forced = new Request("http://localhost:3000/api/wapps/templates/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ root, force: true }),
      });
      const forcedResponse = await handleWappsApi(forced, new URL(forced.url), "POST", authContext, ctx);
      expect(forcedResponse?.status).toBe(201);
      rmSync(root, { recursive: true, force: true });
    } finally {
      cleanup();
    }
  });
});

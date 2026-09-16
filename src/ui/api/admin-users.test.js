import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("../identity/profile.js", () => ({
  fetchAdminUserProfile: async () => ({}),
}));

const { initAdminUsersApi } = await import("./admin-users.js");

function createState() {
  return {
    identity: {
      isAdmin: true,
      npub: "npub1viewer",
    },
    adminUsers: {
      items: [],
      initialized: false,
      loading: false,
      error: null,
      pending: new Set(),
      selection: new Set(),
      nicknameDrafts: new Map(),
      pictureRequests: new Set(),
      pictureCache: new Map(),
      addDraft: "",
      addBusy: false,
      addError: null,
      bulkDeleteBusy: false,
    },
  };
}

function createApiHarness() {
  const state = createState();
  const renders = [];
  const requests = [];
  const api = initAdminUsersApi({
    state,
    getCurrentRoute: () => "settings",
    render: () => renders.push(Date.now()),
    normaliseNpubValue: (value) => (typeof value === "string" && value.trim() ? value.trim() : null),
    isFiniteNumber: Number.isFinite,
    ADMIN_PICTURE_CACHE_TTL_MS: 1_000,
  });
  return { api, state, renders, requests };
}

afterEach(() => {
  delete globalThis.fetch;
  delete globalThis.confirm;
});

describe("admin users UI API", () => {
  test("toggleUserAdmin PATCHes the admin flag without changing normal access", async () => {
    const { api, requests } = createApiHarness();
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json({
        user: { npub: "npub1target", normalizedNpub: "npub1target", admin: true, approved: false },
      });
    };

    await api.toggleUserAdmin("npub1target", true);

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/api/admin/users");
    expect(requests[0].init.method).toBe("PATCH");
    expect(JSON.parse(requests[0].init.body)).toEqual({ npub: "npub1target", admin: true });
  });

  test("toggleUserOnboarding PATCHes the approved flag without changing admin", async () => {
    const { api, requests } = createApiHarness();
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json({
        user: { npub: "npub1target", normalizedNpub: "npub1target", admin: true, approved: false },
      });
    };

    await api.toggleUserOnboarding("npub1target", false);

    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0].init.body)).toEqual({ npub: "npub1target", approved: false });
  });

  test("self admin demotion adds explicit confirmation to the payload", async () => {
    const { api, requests } = createApiHarness();
    globalThis.confirm = () => true;
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json({
        user: { npub: "npub1viewer", normalizedNpub: "npub1viewer", admin: false, approved: true },
      });
    };

    await api.toggleUserAdmin("npub1viewer", false);

    expect(JSON.parse(requests[0].init.body)).toEqual({
      npub: "npub1viewer",
      admin: false,
      confirmSelfAdminDemotion: true,
    });
  });

  test("self admin deletion adds explicit confirmation to the payload", async () => {
    const { api, state, requests } = createApiHarness();
    state.adminUsers.items = [{
      npub: "npub1viewer",
      normalizedNpub: "npub1viewer",
      alias: "Viewer",
      admin: true,
    }];
    globalThis.confirm = () => true;
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json({ users: [] });
    };

    await api.deleteAdminUser("npub1viewer", "Viewer");

    expect(JSON.parse(requests[0].init.body)).toEqual({
      npub: "npub1viewer",
      confirmSelfAdminDeletion: true,
    });
  });
});

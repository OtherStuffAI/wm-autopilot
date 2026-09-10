import { afterEach, expect, test } from "bun:test";
import { createSigningPoliciesSection } from "./signing-policies-section.js";
import { validateSigningPolicyDraft } from "../../../signing/signing-policy-validation.ts";

class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.style = {};
    this.listeners = {};
    this.value = "";
    this.textContent = "";
    this.disabled = false;
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes[key] = value; }
  querySelector() { return { focus() {} }; }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  async click() { if (!this.disabled) await this.listeners.click?.(); }
}
function find(root, id) {
  if (root.dataset.testid === id) return root;
  for (const child of root.children) {
    const found = find(child, id);
    if (found) return found;
  }
}
const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;
afterEach(() => { globalThis.fetch = originalFetch; globalThis.document = originalDocument; });
const draft = () => ({
  id: "synthetic-import", name: "Synthetic", description: "Reviewed synthetic policy", enabled: true,
  operations: ["nostr.sign"], eventKinds: [30617], nip98Targets: [],
  assignments: { profileIds: ["profile-a"], workspaceIds: ["workspace-a"] },
  nostrKindRules: [{ kind: 30617, maxContentBytes: 0, maxTags: 16, maxTagBytes: 4096,
    allowedTagNames: ["d", "relays"], exactTags: [["d", "synthetic"], ["relays", "wss://one.example/", "wss://two.example/"]] }],
});
async function setup({ policies = [], error, failLoad = false } = {}) {
  const calls = [];
  globalThis.document = { createElement: (tag) => new Element(tag) };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, ...options });
    if (options.method === "POST") {
      if (error) return Response.json({ error }, { status: 400 });
      const policy = { ...validateSigningPolicyDraft(JSON.parse(options.body)), revision: 1 };
      if (policies.some((item) => item.id === policy.id)) return Response.json({ error: "Signing policy ID already exists" }, { status: 400 });
      policies.push(policy);
      return Response.json({ policy }, { status: 201 });
    }
    if (failLoad) return Response.json({ error: "Administrator access required" }, { status: 403 });
    return Response.json(url === "/api/admin/signing-policies"
      ? { policies, sessions: [] } : { policy: policies.find((item) => url.endsWith(item.id)), history: [], sessions: [] });
  };
  const root = createSigningPoliciesSection({ createState: (receive) => ({
    async refresh(preferredId) {
      const { loadSigningPolicies, loadSigningPolicy } = await import("../../services/signing-policies.js");
      const inventory = await loadSigningPolicies();
      const selectedId = inventory.policies.some((p) => p.id === preferredId) ? preferredId : inventory.policies[0]?.id;
      const detail = selectedId ? await loadSigningPolicy(selectedId) : null;
      receive({ inventory, selectedId, detail });
    },
  }) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (!failLoad) await find(root, "signing-policy-add").click();
  const get = (suffix) => find(root, `signing-policy-import-${suffix}`);
  const paste = (value) => { get("json").value = value; get("json").listeners.input(); };
  return { root, get, paste, calls, policies, posts: () => calls.filter((call) => call.method === "POST") };
}

test("review then create only a new disabled policy; preserve exact tags and assignments; repeat for second draft", async () => {
  const ui = await setup();
  const policy = draft();
  ui.paste(JSON.stringify(policy));
  expect(ui.get("create").disabled).toBe(true);
  await ui.get("review").click();
  expect(ui.posts()).toHaveLength(0);
  expect(JSON.parse(ui.get("preview").textContent)).toEqual({ ...policy, enabled: false });
  expect(ui.get("preview").hidden).toBe(false);
  await ui.get("create").click();
  expect(ui.posts()).toHaveLength(1);
  expect(ui.posts()[0].url).toBe("/api/admin/signing-policies");
  expect(ui.posts()[0].credentials).toBe("include");
  expect(JSON.parse(ui.posts()[0].body)).toEqual({ ...policy, enabled: false });
  expect(ui.policies[0].nostrKindRules[0].exactTags).toEqual(policy.nostrKindRules[0].exactTags);
  expect(ui.policies[0].assignments).toEqual(policy.assignments);
  expect(ui.get("json").value).toBe("");
  expect(ui.get("status").textContent).toContain("Created synthetic-import disabled");
  expect(find(ui.root, "signing-policy-json").value).toContain('"enabled": false');
  ui.paste(JSON.stringify({ ...policy, id: "second-import" }));
  await ui.get("review").click();
  await ui.get("create").click();
  expect(ui.posts()).toHaveLength(2);
  expect(ui.policies.every((item) => !item.enabled)).toBe(true);
  expect(ui.calls.some((call) => /enabled|reissue/.test(call.url))).toBe(false);
});

test("invalid JSON and shapes retain input and cannot create", async () => {
  const ui = await setup();
  for (const value of ["{bad", "null", "[]", "{}", JSON.stringify({ ...draft(), assignments: [] }),
    JSON.stringify({ ...draft(), enabled: "true" }), JSON.stringify({ ...draft(), unexpected: true }),
    JSON.stringify({ ...draft(), nostrKindRules: [{ exactTags: [["d", 42]] }] })]) {
    ui.paste(value);
    await ui.get("review").click();
    expect(ui.get("create").disabled).toBe(true);
    expect(ui.get("json").value).toBe(value);
    expect(ui.get("status").textContent.length).toBeGreaterThan(0);
    await ui.get("create").click();
  }
  expect(ui.posts()).toHaveLength(0);
});

test("duplicate inventory ID is rejected without overwriting", async () => {
  const ui = await setup({ policies: [{ ...draft(), revision: 1 }] });
  ui.paste(JSON.stringify(draft()));
  await ui.get("review").click();
  expect(ui.get("status").textContent).toContain("already exists");
  expect(ui.get("create").disabled).toBe(true);
  expect(ui.posts()).toHaveLength(0);
});

test("server validation, duplicate-race and network errors retain input and require another review", async () => {
  for (const error of ["Signing policy ID already exists", "NIP-98 path is overbroad", "Request failed"]) {
    const ui = await setup({ error });
    const text = JSON.stringify(draft());
    ui.paste(text);
    await ui.get("review").click();
    if (error === "Request failed") globalThis.fetch = async () => { throw new Error(error); };
    await ui.get("create").click();
    expect(ui.get("json").value).toBe(text);
    expect(ui.get("status").textContent).toBe(error);
    expect(ui.get("create").disabled).toBe(true);
    expect(ui.get("review").disabled).toBe(false);
  }
});

test("editing reviewed text invalidates create; programmatic changes also cannot bypass review", async () => {
  const ui = await setup();
  ui.paste(JSON.stringify(draft()));
  await ui.get("review").click();
  ui.paste(JSON.stringify({ ...draft(), id: "changed-import" }));
  expect(ui.get("create").disabled).toBe(true);
  expect(ui.get("preview").hidden).toBe(true);
  await ui.get("review").click();
  ui.get("json").value = JSON.stringify(draft());
  await ui.get("create").click();
  expect(ui.get("status").textContent).toContain("Draft changed");
  expect(ui.posts()).toHaveLength(0);
});

test("import is hidden when admin inventory is unavailable", async () => {
  const ui = await setup({ failLoad: true });
  expect(find(ui.root, "signing-policy-import").hidden).toBe(true);
  expect(ui.posts()).toHaveLength(0);
});

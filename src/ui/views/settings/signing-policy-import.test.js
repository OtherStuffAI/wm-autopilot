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
async function setup({ policies = [], error, failLoad = false, confirmAction = () => true } = {}) {
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
    if (options.method === "PUT") {
      if (error) return Response.json({ error }, { status: 400 });
      const draft = validateSigningPolicyDraft(JSON.parse(options.body));
      const index = policies.findIndex((item) => item.id === draft.id);
      if (index < 0) return Response.json({ error: "Signing policy not found" }, { status: 404 });
      const policy = { ...policies[index], ...draft, revision: (policies[index].revision || 1) + 1, builtIn: policies[index].builtIn ?? false };
      policies[index] = policy;
      return Response.json({ policy });
    }
    if (options.method === "DELETE") {
      if (error) return Response.json({ error }, { status: 400 });
      const id = decodeURIComponent(String(url).split("/").pop());
      const index = policies.findIndex((item) => item.id === id);
      if (index < 0) return Response.json({ error: "Signing policy not found" }, { status: 404 });
      const [policy] = policies.splice(index, 1);
      return Response.json({
        deleted: { id: policy.id, revision: policy.revision, name: policy.name },
        history: [{ policyId: policy.id, revision: policy.revision, action: "deleted", snapshot: policy }],
        sessions: [],
        consequence: "Existing issued capabilities are not mutated here.",
      });
    }
    if (failLoad) return Response.json({ error: "Administrator access required" }, { status: 403 });
    return Response.json(url === "/api/admin/signing-policies"
      ? { policies, sessions: [] } : { policy: policies.find((item) => url.endsWith(item.id)), history: [], sessions: [] });
  };
  const root = createSigningPoliciesSection({ confirmAction, createState: (receive) => ({
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

test("replace JSON requires review, saves the same ID, and surfaces server errors without clearing pasted text", async () => {
  const policy = { ...draft(), id: "replace-me", revision: 1, builtIn: false };
  const ui = await setup({ policies: [policy] });
  await find(ui.root, "signing-policy-edit-json").click();
  const textarea = find(ui.root, "signing-policy-json");
  const replacement = { ...draft(), id: "replace-me", name: "Replacement", description: "Reviewed replacement", enabled: true };
  textarea.value = JSON.stringify({ ...replacement, id: "wrong-id" });
  textarea.listeners.input();
  await find(ui.root, "signing-policy-review-json").click();
  expect(find(ui.root, "signing-policies-status").textContent).toContain("Replacement ID must stay replace-me");
  expect(find(ui.root, "signing-policy-save").disabled).toBe(true);

  textarea.value = JSON.stringify(replacement);
  textarea.listeners.input();
  await find(ui.root, "signing-policy-review-json").click();
  expect(JSON.parse(find(ui.root, "signing-policy-review-preview").textContent)).toEqual(replacement);
  textarea.value = JSON.stringify({ ...replacement, description: "Changed after review" });
  await find(ui.root, "signing-policy-save").click();
  expect(find(ui.root, "signing-policies-status").textContent).toContain("Replacement changed");
  expect(ui.calls.filter((call) => call.method === "PUT")).toHaveLength(0);

  textarea.value = JSON.stringify(replacement);
  textarea.listeners.input();
  await find(ui.root, "signing-policy-review-json").click();
  await find(ui.root, "signing-policy-save").click();
  const puts = ui.calls.filter((call) => call.method === "PUT");
  expect(puts).toHaveLength(1);
  expect(puts[0].url).toBe("/api/admin/signing-policies/replace-me");
  expect(JSON.parse(puts[0].body)).toEqual(replacement);
  expect(ui.policies[0].name).toBe("Replacement");

  const failing = await setup({ policies: [{ ...policy }], error: "server validation failed" });
  await find(failing.root, "signing-policy-edit-json").click();
  const failingText = find(failing.root, "signing-policy-json");
  failingText.value = JSON.stringify(replacement);
  failingText.listeners.input();
  await find(failing.root, "signing-policy-review-json").click();
  await find(failing.root, "signing-policy-save").click();
  expect(find(failing.root, "signing-policies-status").textContent).toBe("server validation failed");
  expect(failingText.value).toBe(JSON.stringify(replacement));
});

test("delete custom policy requires confirmation and removes it through the admin API", async () => {
  const policy = { ...draft(), id: "delete-me", revision: 1, builtIn: false };
  const confirmations = [];
  const ui = await setup({ policies: [policy], confirmAction: (message) => { confirmations.push(message); return true; } });
  await find(ui.root, "signing-policy-delete").click();
  expect(confirmations[0]).toContain("Existing issued capabilities are not changed");
  const deletes = ui.calls.filter((call) => call.method === "DELETE");
  expect(deletes).toHaveLength(1);
  expect(deletes[0].url).toBe("/api/admin/signing-policies/delete-me");
  expect(ui.policies).toHaveLength(0);

  const cancelled = await setup({ policies: [{ ...policy }], confirmAction: () => false });
  await find(cancelled.root, "signing-policy-delete").click();
  expect(cancelled.calls.some((call) => call.method === "DELETE")).toBe(false);
  expect(cancelled.policies).toHaveLength(1);
});

test("header edit action opens the collapsed editor and previews status changes", async () => {
  const ui = await setup({ policies: [{ ...draft(), builtIn: false, revision: 1 }] });
  const edit = find(ui.root, "signing-policy-edit-json");
  const editor = find(ui.root, "signing-policy-editor");
  expect(find(editor, "signing-policy-edit-json")).toBeUndefined();
  await edit.click();
  expect(editor.open).toBe(true);
  const input = find(ui.root, "signing-policy-json");
  input.value = JSON.stringify({ ...draft(), enabled: false });
  input.listeners.input();
  await find(ui.root, "signing-policy-review-json").click();
  await find(ui.root, "signing-policy-save").click();
  expect(ui.policies[0].enabled).toBe(false);
});

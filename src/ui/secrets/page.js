import Alpine from "/vendor/alpinejs/module.esm.js";
import { Dexie, secretsDb } from "./db.js";
import { saveSecret, snapshotId, syncSecrets, revokeSecret, syncSecretAudit } from "./service.js";
import { button, element, field, select } from "./controls.js";
import { createSecretEditor } from "./editor.js";

Alpine.data("autopilotSecrets", () => ({
  snapshot: null,
  init() {
    this.$watch("snapshot", value => { if (value) this.$el.renderSecretSnapshot(value); });
    this.watchWorkspace("local");
    this.$el.secretSync();
  },
  watchWorkspace(workspace) {
    this.query?.unsubscribe();
    const owner = this.$el.dataset.owner;
    this.query = Dexie.liveQuery(() => secretsDb.snapshots.get(snapshotId(owner, workspace))).subscribe({
      next: value => { this.snapshot = value || null; }, error: error => this.$el.secretError(error),
    });
  },
  destroy() {
    this.query?.unsubscribe();
    this.$el.clearSecretEntry();
    clearInterval(this.$el.secretTimer);
  },
}));

export function createSecretsPage({ ownerNpub } = {}) {
  const host = element("section", "", "wm-settings-page wm-secrets-page");
  host.setAttribute("aria-label", "Manage secrets"); host.dataset.testid = "secrets-page";
  host.dataset.owner = ownerNpub || ""; host.setAttribute("x-data", "autopilotSecrets");
  const header = element("header"); header.append(element("h1", "Secrets"),
    element("p", "Manage encrypted credentials for Autopilot pipelines and agent sessions. Values are never shown in this list."));
  const status = element("p", "Loading secrets…"); status.setAttribute("aria-live", "polite");
  status.setAttribute("role", "status"); status.dataset.testid = "secrets-status";
  const toolbar = element("div", "", "wm-secret-toolbar");
  const listing = element("div"); const editor = element("div"); const audit = element("section");
  audit.setAttribute("aria-label", "Secret access audit"); audit.dataset.testid = "secret-audit";
  let workspace = "local"; let busy = false; let editing = false; let stopped = false;
  const newButton = button("Add secret", async () => {
    const snapshot = await secretsDb.snapshots.get(snapshotId(ownerNpub, workspace));
    if (!snapshot) return host.secretError(new Error("Refresh metadata before adding a secret"));
    showEditor(null, snapshot.inventory);
  }, "secret-add");
  const refreshButton = button("Refresh", () => host.secretSync(), "secrets-refresh");
  toolbar.append(newButton, refreshButton); host.append(header, status, toolbar, listing, editor, audit);
  host.secretError = error => { status.textContent = error.message || "Secrets could not be loaded"; };
  host.clearSecretEntry = () => { stopped = true; editor.querySelectorAll('input[type="password"]').forEach(node => { node.value = ""; }); };
  host.secretSync = async () => {
    if (busy || stopped) return;
    if (!ownerNpub) return host.secretError(new Error("Sign in to manage secrets"));
    busy = true; host.setAttribute("aria-busy", "true");
    try { await syncSecrets(ownerNpub, workspace); status.textContent = "Metadata refreshed."; }
    catch (error) { host.secretError(error); }
    finally { busy = false; host.setAttribute("aria-busy", "false"); }
  };
  function closeEditor() { editor.replaceChildren(); editing = false; newButton.disabled = false; const picker = toolbar.querySelector("select"); if (picker) picker.disabled = false; }
  function showEditor(record, inventory) {
    if (editing) return;
    editing = true; newButton.disabled = true; const picker = toolbar.querySelector("select"); if (picker) picker.disabled = true;
    editor.replaceChildren(createSecretEditor({ record, inventory, onCancel: closeEditor, onSave: async input => {
      await saveSecret(workspace, record?.id, input); closeEditor(); await host.secretSync(); status.textContent = "Secret saved.";
    } }));
    editor.querySelector("input")?.focus();
  }
  host.renderSecretSnapshot = snapshot => {
    listing.replaceChildren();
    const oldSelector = toolbar.querySelector("label"); oldSelector?.remove();
    const picker = select(snapshot.inventory.workspaces.map(row => [row.id, row.label]), workspace);
    picker.disabled = editing;
    picker.addEventListener("change", () => {
      if (editing) { picker.value = workspace; return; }
      workspace = picker.value; listing.replaceChildren(); audit.replaceChildren();
      Alpine.$data(host).watchWorkspace(workspace); void host.secretSync();
    });
    toolbar.prepend(field("Workspace", picker, "secrets-workspace"));
    if (!snapshot.secrets.length) listing.append(element("p", "No secrets in this workspace. Add a secret to get started."));
    for (const record of snapshot.secrets) {
      const card = element("article", "", "wm-card"); card.dataset.testid = `secret-${record.id}`;
      card.append(element("h2", record.label), element("p", `${record.type === "nostr" ? "Nostr signing key" : "Secret"} · ${record.revokedAt ? "Revoked; value erased" : "Active"} · revision ${record.revision}`),
        element("p", `Reference: ${record.id}`), element("p", `Allowed identities: ${record.policy.identities.length} · Pipelines: ${scope(record.policy.pipelines)} · Agent sessions: ${scope(record.policy.agents)} · Raw return: ${record.policy.allowExport ? "enabled" : "disabled"}`),
        element("p", `Updated: ${record.updatedAt} · Last used: ${record.lastUsedAt || "Never"}`));
      if (record.publicNpub) card.append(element("p", `Signing identity: ${record.publicNpub}`),
        element("p", `Allowed event kinds: ${record.policy.kindMode === "all" ? "All Nostr kinds" : (record.policy.kindRules.map(rule => rule.kind).join(", ") || "None")}`));
      if (!record.revokedAt) card.append(button(`Edit ${record.label}`, () => showEditor(record, snapshot.inventory), `secret-edit-${record.id}`),
        button(`Revoke / delete ${record.label}`, async () => {
          if (!window.confirm(`Revoke ${record.label} and permanently erase its stored value?`)) return;
          try { await revokeSecret(workspace, record.id, record.revision); await host.secretSync(); status.textContent = "Secret revoked; stored value erased."; }
          catch (error) { host.secretError(error); }
        }, `secret-revoke-${record.id}`));
      card.append(button(`Access audit for ${record.label}`, async () => {
        try { await syncSecretAudit(ownerNpub, workspace, record.id); } catch (error) { host.secretError(error); }
      }, `secret-audit-${record.id}`));
      listing.append(card);
    }
    audit.replaceChildren();
    if (snapshot.auditId) {
      audit.append(element("h2", "Access audit"));
      if (!snapshot.audit.length) audit.append(element("p", "No recorded operations."));
      for (const entry of snapshot.audit) audit.append(element("p", `${entry.at} · ${entry.operation} · ${entry.outcome} · ${entry.identity} · ${entry.context}: ${entry.contextId}`));
    }
  };
  host.secretTimer = setInterval(() => { if (!editing && document.visibilityState === "visible") void host.secretSync(); }, 15_000);
  return host;
}
function scope(policy) { return policy.enabled ? (policy.mode === "all" ? "all" : `${policy.ids.length} selected`) : "off"; }

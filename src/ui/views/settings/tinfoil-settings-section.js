import Alpine from "/vendor/alpinejs/module.esm.js";
import { Dexie, secretsDb } from "../../secrets/db.js";
import { snapshotId, syncSecrets } from "../../secrets/service.js";
import { button, element, field, select } from "../../secrets/controls.js";
import { modelProviderPanel } from "./tinfoil-provider-panel.js";

Alpine.data("autopilotModelProviders", () => ({
  snapshot: null,
  init() {
    this.$watch("snapshot", value => { if (value) this.$el.renderProviderSnapshot(value); });
    this.watchWorkspace(this.$el.providerWorkspace);
    void this.$el.refreshProviders();
  },
  watchWorkspace(workspace) {
    this.query?.unsubscribe();
    this.query = Dexie.liveQuery(() => secretsDb.snapshots.get(snapshotId(this.$el.dataset.owner, workspace)))
      .subscribe({ next: value => { this.snapshot = value || null; }, error: error => this.$el.providerError(error) });
  },
  destroy() { this.query?.unsubscribe(); },
}));

export function createTinfoilSettingsSection({ ownerNpub } = {}) {
  const host = element("section", "", "wm-card");
  host.dataset.testid = "model-provider-settings";
  host.dataset.owner = ownerNpub || "";
  host.setAttribute("aria-label", "Model providers");
  host.setAttribute("x-data", "autopilotModelProviders");
  host.providerWorkspace = new URLSearchParams(window.location.search).get("workspace") || "local";
  const status = element("p", "Loading saved provider metadata…");
  status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const toolbar = element("div"); const panel = element("div");
  const secrets = element("a", "Manage saved credentials and permissions in Secrets");
  secrets.setAttribute("aria-label", "Manage model provider credentials in Secrets");
  let editing = false; let busy = false;
  host.providerError = error => { status.textContent = error.message || "Provider metadata could not be loaded"; };
  host.refreshProviders = async () => {
    if (busy) return;
    if (!ownerNpub) return host.providerError(new Error("Sign in to manage model providers"));
    busy = true;
    try { await syncSecrets(ownerNpub, host.providerWorkspace); status.textContent = "Saved provider metadata loaded."; }
    catch (error) { host.providerError(error); }
    finally { busy = false; }
  };
  host.renderProviderSnapshot = snapshot => {
    if (editing || snapshot.workspace !== host.providerWorkspace) return;
    const picker = select(snapshot.inventory.workspaces.map(row => [row.id, row.label]), host.providerWorkspace);
    picker.addEventListener("change", () => {
      host.providerWorkspace = picker.value;
      const url = new URL(window.location.href); url.searchParams.set("workspace", picker.value);
      window.history.replaceState(window.history.state, "", url);
      panel.replaceChildren(); Alpine.$data(host).watchWorkspace(picker.value); void host.refreshProviders();
    });
    toolbar.replaceChildren(field("Provider workspace", picker, "model-provider-workspace"),
      button("Refresh provider metadata", () => host.refreshProviders(), "model-provider-refresh"));
    secrets.href = `/secrets?workspace=${encodeURIComponent(host.providerWorkspace)}`;
    panel.replaceChildren(modelProviderPanel(snapshot, { ownerNpub, workspace: host.providerWorkspace,
      refresh: () => host.refreshProviders(), onError: host.providerError,
      setEditing: value => { editing = value; picker.disabled = value; },
    }));
  };
  host.append(element("h2", "Model providers"), toolbar, status, panel, secrets);
  return host;
}

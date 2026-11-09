
/** Persist metadata before rendering provider/model choices. */
export function createModelProviderLaunch({ modelSelect, agentSelect, onChange }) {
  if (!modelSelect?.parentElement) return null;
  const field = document.createElement("label");
  field.textContent = "Model provider"; field.className = "wm-session-dialog__field";
  const provider = document.createElement("select");
  provider.setAttribute("aria-label", "Model provider"); provider.dataset.testid = "session-model-provider";
  for (const [value, label] of [["existing", "Configured runner provider"], ["tinfoil", "Tinfoil"]]) {
    const option = document.createElement("option"); option.value = value; option.textContent = label; provider.append(option);
  }
  const workspaceLabel = document.createElement("label"); workspaceLabel.textContent = "Provider workspace"; workspaceLabel.className = "wm-session-dialog__field";
  const workspace = document.createElement("select");
  const local = document.createElement("option"); local.value = "local"; local.textContent = "Autopilot local"; workspace.append(local);
  workspace.setAttribute("aria-label", "Provider workspace"); workspace.dataset.testid = "session-provider-workspace";
  const status = document.createElement("p"); status.className = "wm-session-dialog__hint"; status.setAttribute("aria-live", "polite");
  field.append(provider); workspaceLabel.append(workspace);
  modelSelect.parentElement.before(field, workspaceLabel, status);
  let subscription;
  let connection = null;
  async function load() {
    subscription?.unsubscribe(); connection = null;
    if (provider.value !== "tinfoil") { status.textContent = ""; onChange(); return; }
    const { Dexie, secretsDb } = await import("../secrets/db.js");
    const { snapshotId, syncSecrets } = await import("../secrets/service.js");
    const { state } = await import("../state/index.js");
    const owner = state.identity.npub;
    if (!owner || !state.identity.authenticated) throw new Error("Sign in to select a provider");
    subscription = Dexie.liveQuery(() => secretsDb.snapshots.get(snapshotId(owner, workspace.value))).subscribe({ next: snapshot => {
      connection = snapshot?.modelProvider;
      if (snapshot?.inventory?.workspaces) {
        const selected = workspace.value;
        workspace.replaceChildren();
        for (const row of snapshot.inventory.workspaces) {
          const option = document.createElement("option"); option.value = row.id; option.textContent = row.label; workspace.append(option);
        }
        workspace.value = selected;
      }
      status.textContent = connection?.enabled ? "Uses the saved credential policy. Choose an allowed agent profile." : "Configure Tinfoil in Settings → Model choices for this workspace first.";
      onChange();
    }, error: error => { status.textContent = error.message; } });
    await syncSecrets(owner, workspace.value);
  }
  const reload = () => { void load().catch(error => { status.textContent = error.message; }); };
  provider.addEventListener("change", reload); workspace.addEventListener("change", reload);
  return {
    sync() { field.hidden = !["pi", "opencode", "goose"].includes(agentSelect?.value); workspaceLabel.hidden = field.hidden || provider.value !== "tinfoil"; },
    models(fallback) { return provider.value === "tinfoil" && !field.hidden ? (connection?.enabled ? connection.models : []) : fallback; },
    metadata() { return provider.value === "tinfoil" && !field.hidden ? { modelProvider: "tinfoil", modelProviderWorkspaceId: workspace.value } : {}; },
    destroy() { subscription?.unsubscribe(); },
  };
}

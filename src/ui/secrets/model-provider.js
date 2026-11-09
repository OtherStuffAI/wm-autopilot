import { button, element, field, input, select } from "./controls.js";
import { saveModelProvider, testModelProvider } from "./service.js";

export function modelProviderPanel(snapshot, { ownerNpub, workspace, refresh, onError, setEditing = () => {} }) {
  const panel = element("section", "", "wm-card");
  panel.setAttribute("aria-label", "Model provider connection"); panel.dataset.testid = "tinfoil-provider";
  panel.append(element("h2", "Tinfoil model provider"), element("p", "Reuse an encrypted saved credential with Pi, OpenCode or Goose. Only selected secret identities may launch; raw export stays disabled. The local proxy verifies inference connections."));
  if (!snapshot.modelProviderAvailable) {
    panel.append(element("p", "Provider connection management requires Autopilot server activation.")); return panel;
  }
  const connection = snapshot.modelProvider;
  const secrets = snapshot.secrets.filter(record => record.type === "secret" && !record.revokedAt);
  const reference = select([["", "Select saved credential"], ...secrets.map(row => [row.id, row.label])], connection?.credentialRef || "");
  const models = input("text", (connection?.models || ["kimi-k3-1-pro"]).join(", "));
  const enabled = input("checkbox"); enabled.checked = connection?.enabled ?? true;
  const identity = select([["", "Select allowed agent identity"], ...snapshot.inventory.identities.filter(row => row.type === "bot").map(row => [row.npub, row.label])], "");
  const state = element("p", snapshot.modelProviderTest?.connected ? `Connection and tool calling verified for ${snapshot.modelProviderTest.model}.` : "Save a connection, then test with an allowed identity. Tests make a small billed request.");
  state.setAttribute("role", "status"); state.setAttribute("aria-live", "polite"); state.dataset.testid = "tinfoil-provider-status";
  const save = button("Save Tinfoil connection", async () => {
    save.disabled = true;
    try { await saveModelProvider(ownerNpub, workspace, { credentialRef: reference.value, models: models.value.split(",").map(value => value.trim()).filter(Boolean), enabled: enabled.checked, revision: connection?.revision ?? 0 }); setEditing(false); await refresh(); }
    catch (error) { onError(error); } finally { save.disabled = false; }
  }, "tinfoil-save");
  const test = button("Test Tinfoil connection and tool calling", async () => {
    test.disabled = true;
    try { await testModelProvider(ownerNpub, workspace, identity.value); }
    catch (error) { onError(error); } finally { test.disabled = false; }
  }, "tinfoil-test");
  test.disabled = !connection?.enabled;
  for (const control of [reference, models, enabled]) control.addEventListener("input", () => setEditing(true));
  panel.append(field("Saved credential", reference, "tinfoil-credential"), field("Allowed model IDs (comma separated)", models, "tinfoil-models"),
    field("Enable Tinfoil", enabled, "tinfoil-enabled"), save, field("Test as agent identity", identity, "tinfoil-test-identity"), test, state);
  return panel;
}

import { button, choices, contextControl, element, field, input, select } from "./controls.js";
import { signingControls } from "./signing-controls.js";

export function createSecretEditor({ record, inventory, onSave, onCancel }) {
  const form = element("form", "", "wm-card wm-secret-editor");
  form.dataset.testid = "secret-editor";
  const heading = element("h2", record ? `Edit ${record.label}` : "Add secret");
  const label = input("text", record?.label || ""); label.required = true; label.maxLength = 160;
  const type = select([["secret", "API token or other secret"], ["nostr", "Nostr signing key"]], record?.type || "secret");
  const value = input("password"); value.autocomplete = "new-password"; value.required = !record;
  value.setAttribute("spellcheck", "false");
  const identities = choices("Allowed users and bots (required for every use)", inventory.identities,
    record?.policy?.identities || [], "npub", "secret-identity");
  const additional = element("textarea"); additional.rows = 2; additional.autocomplete = "off";
  const pipelines = contextControl("Pipelines", inventory.pipelines, record?.policy?.pipelines, "id", "secret-pipelines");
  const agents = contextControl("Agent sessions", inventory.identities.filter(row => row.type === "bot"), record?.policy?.agents, "npub", "secret-agents");
  const exportValue = input("checkbox"); exportValue.checked = record?.policy?.allowExport === true;
  const signing = signingControls(record);
  const note = element("p", "New secrets have no consumer access until you grant it. Both an allowed identity and its pipeline or agent context must match. Management remains with your authenticated identity.");
  const exportNote = element("p");
  const status = element("p"); status.setAttribute("aria-live", "polite"); status.setAttribute("role", "status");
  const save = element("button", record ? "Save changes" : "Create secret", "wm-button"); save.type = "submit";
  save.setAttribute("aria-label", save.textContent); save.dataset.testid = "secret-save";
  const cancel = button("Cancel", () => { value.value = ""; onCancel(); }, "secret-cancel");
  function updateType() {
    value.required = !record || type.value !== record.type;
    signing.node.hidden = type.value !== "nostr";
    exportNote.textContent = type.value === "nostr"
      ? "Sign-only by default. Enable raw return only when a permitted consumer must receive the private key. Kind restrictions apply to signing, not exported keys."
      : "Enable raw return to let permitted sessions read this value or pipelines use it in the supported HTTP adapter.";
  }
  type.addEventListener("change", updateType); updateType();
  form.append(heading, note, element("p", "Replacing a signing identity or changing secret type resets all consumer grants. Review the saved metadata and grant access again."), field("Secret name", label, "secret-label"), field("Secret type", type, "secret-type"),
    field(record ? "Replacement value (leave empty to keep current)" : "Secret value", value, "secret-value"),
    identities.node, field("Additional allowed npubs (one per line)", additional, "secret-additional-identities"),
    pipelines.node, agents.node, field("Permit raw value return", exportValue, "secret-export"), exportNote, signing.node,
    status, save, cancel);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    let submitted;
    try {
      const allowed = [...new Set([...identities.values(), ...additional.value.split(/\s+/).filter(Boolean)])];
      submitted = { label: label.value.trim(), type: type.value,
        ...(record ? { revision: record.revision } : {}), ...(value.value ? { value: value.value } : {}),
        policy: { identities: allowed, pipelines: pipelines.value(), agents: agents.value(), allowExport: exportValue.checked,
          ...(type.value === "nostr" ? signing.value() : { kindMode: "selected", kindRules: [] }) } };
      // Clear the sensitive DOM field before any network wait, including rejected submissions.
      value.value = "";
      save.disabled = true; cancel.disabled = true; status.textContent = "Saving…";
      await onSave(submitted);
    } catch (error) { status.textContent = error.message; }
    finally { value.value = ""; if (submitted) delete submitted.value; save.disabled = false; cancel.disabled = false; }
  });
  return form;
}

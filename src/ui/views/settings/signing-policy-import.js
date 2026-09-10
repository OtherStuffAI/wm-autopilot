import { saveSigningPolicy } from "../../services/signing-policies.js";

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim());
}

export function parseSigningPolicyImport(text, existingIds = []) {
  let draft;
  try { draft = JSON.parse(text); } catch { throw new Error("Invalid JSON. Paste one complete policy object."); }
  if (!object(draft)) throw new Error("Policy must be one JSON object, not a list or wrapper.");
  const fields = ["id", "name", "description", "enabled", "operations", "eventKinds", "nostrKindRules", "nip98Targets", "assignments"];
  if (Object.keys(draft).some((key) => !fields.includes(key))) {
    throw new Error("Unexpected policy field. Import a draft with only id, name, description, enabled, operations, eventKinds, nostrKindRules, nip98Targets and assignments.");
  }
  if (typeof draft.id !== "string" || !/^[a-z][a-z0-9-]{2,63}$/.test(draft.id)) {
    throw new Error("Policy ID must be 3–64 lowercase letters, numbers or hyphens, starting with a letter.");
  }
  if (existingIds.includes(draft.id)) throw new Error(`Policy ID already exists: ${draft.id}. Import cannot overwrite it.`);
  for (const [key, limit] of [["name", 100], ["description", 1000]]) {
    if (typeof draft[key] !== "string" || !draft[key].trim() || draft[key].length > limit) {
      throw new Error(`Policy ${key} is required and must be at most ${limit} characters.`);
    }
  }
  if (draft.enabled !== undefined && typeof draft.enabled !== "boolean") throw new Error("enabled must be a boolean.");
  if (!strings(draft.operations) || !draft.operations.length || draft.operations.some((op) => !["nip98.sign", "nostr.sign"].includes(op))) {
    throw new Error("operations must contain constrained nip98.sign or nostr.sign operations.");
  }
  if (!Array.isArray(draft.eventKinds) || !draft.eventKinds.length || draft.eventKinds.some((kind) => !Number.isInteger(kind) || kind < 0 || kind > 65535)) {
    throw new Error("eventKinds must contain integer kinds between 0 and 65535.");
  }
  if (!Array.isArray(draft.nip98Targets) || draft.nip98Targets.some((target) => !object(target))) throw new Error("nip98Targets must be an array of target objects.");
  if (draft.nostrKindRules !== undefined && (!Array.isArray(draft.nostrKindRules) || draft.nostrKindRules.some((rule) => !object(rule)))) {
    throw new Error("nostrKindRules must be an array of rule objects.");
  }
  for (const rule of draft.nostrKindRules || []) {
    if (rule.exactTags !== undefined && (!Array.isArray(rule.exactTags) || rule.exactTags.some((tag) => !Array.isArray(tag) || !tag.length || tag.some((part) => typeof part !== "string")))) {
      throw new Error("exactTags must contain complete, non-empty arrays of strings.");
    }
  }
  if (!object(draft.assignments) || !strings(draft.assignments.profileIds) || !strings(draft.assignments.workspaceIds)
    || Object.keys(draft.assignments).some((key) => !["profileIds", "workspaceIds"].includes(key))) {
    throw new Error("assignments must contain profileIds and workspaceIds arrays of non-empty strings only.");
  }
  return { ...draft, enabled: false };
}

function node(tag, text, testId) {
  const result = document.createElement(tag);
  if (text) result.textContent = text;
  if (testId) result.dataset.testid = testId;
  return result;
}

export function createSigningPolicyImport({ getExistingIds, onCreated }) {
  const root = node("section", undefined, "signing-policy-import");
  root.setAttribute("aria-label", "Import signing policy");
  const input = node("textarea", undefined, "signing-policy-import-json");
  input.rows = 12;
  input.setAttribute("aria-label", "Reviewed policy draft JSON");
  const review = node("button", "Review disabled policy", "signing-policy-import-review");
  const create = node("button", "Create disabled policy", "signing-policy-import-create");
  for (const button of [review, create]) {
    button.type = "button";
    button.className = "wm-button secondary";
    button.setAttribute("aria-label", button.textContent);
  }
  const preview = node("pre", undefined, "signing-policy-import-preview");
  preview.setAttribute("aria-label", "Disabled policy JSON to create");
  preview.style.whiteSpace = "pre-wrap";
  preview.style.overflowWrap = "anywhere";
  const status = node("p", undefined, "signing-policy-import-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  create.disabled = true;
  preview.hidden = true;
  function invalidate() {
    create.disabled = true;
    preview.hidden = true;
    preview.textContent = "";
    status.textContent = "Review the draft before creating it.";
  }
  input.addEventListener("input", invalidate);
  review.addEventListener("click", () => {
    invalidate();
    try {
      preview.textContent = JSON.stringify(parseSigningPolicyImport(input.value, getExistingIds()), null, 2);
      preview.hidden = false;
      create.disabled = false;
      status.textContent = "Review the JSON below. enabled is forced to false. The server validates policy constraints on create.";
    } catch (error) { status.textContent = error.message; }
  });
  create.addEventListener("click", async () => {
    if (create.disabled) return;
    create.disabled = true;
    review.disabled = true;
    input.disabled = true;
    let createdId;
    try {
      const draft = parseSigningPolicyImport(input.value, getExistingIds());
      if (JSON.stringify(draft, null, 2) !== preview.textContent) throw new Error("Draft changed. Review it again before creating.");
      await saveSigningPolicy(draft.id, draft, { create: true });
      createdId = draft.id;
      input.value = "";
      invalidate();
      status.textContent = `Created ${draft.id} disabled. Paste the next draft to import another policy. Enabling and reissuing are separate admin actions.`;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      review.disabled = false;
      input.disabled = false;
    }
    if (createdId) await onCreated(createdId);
  });
  root.append(node("h3", "Import reviewed policy"), node("p", "Open a downloaded JSON draft and paste its contents here. Review each draft separately, then explicitly create it disabled."), input, review, preview, create, status);
  return root;
}

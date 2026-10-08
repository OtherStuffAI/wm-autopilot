import { choices, element, field, input, select } from "./controls.js";

const supportedKinds = [[0, "Profile"], [1, "Text post"], [3, "Contacts"], [5, "Deletion"], [6, "Repost"], [7, "Reaction"], [10002, "Relay list"], [30023, "Article"]];
export function signingControls(record) {
  const group = element("fieldset"); group.append(element("legend", "Allowed signing event kinds"));
  const oldRules = record?.policy?.kindRules || [];
  const chosen = choices("Permit signing", supportedKinds.map(([kind, label]) => ({ id: String(kind), label: `${label} (${kind})` })),
    oldRules.map(rule => String(rule.kind)), "id", "secret-kind");
  const advanced = element("details"); const summary = element("summary", "Signing limits and tag restrictions");
  summary.setAttribute("aria-label", "Signing limits and tag restrictions"); summary.dataset.testid = "secret-signing-limits";
  advanced.append(summary);
  const rules = element("textarea"); rules.rows = 8;
  rules.value = JSON.stringify(oldRules, null, 2);
  advanced.append(element("p", "Optional JSON rules override the default limits for each checked kind. Existing constraints are preserved. Defaults: 8192 content bytes, 16 tags, 4096 tag bytes; tags e, p, t, r, d, title, summary, image, published_at."),
    field("Per-kind signing rules (JSON)", rules, "secret-kind-rules"));
  const mode = select([["selected", "Selected Nostr kinds"], ["all", "All Nostr kinds"]], record?.policy?.kindMode ?? "selected");
  const custom = input("text", oldRules.filter(rule => !supportedKinds.some(([kind]) => kind === rule.kind)).map(rule => rule.kind).join(", "));
  const selected = element("div"); selected.append(chosen.node, field("Additional numeric kinds (comma separated)", custom, "secret-custom-kinds"), advanced);
  const warning = element("p", "All kinds permits external authentication and instruction signing as this imported identity. Allowed consumers may authenticate to external services with its permissions. This does not change the session identity or grant internal broker authority. Limits: 8192 content bytes, 64 tags, 16384 tag bytes and timestamps within five minutes. Selected rules are retained for switching back.");
  function updateMode() { selected.hidden = mode.value === "all"; warning.hidden = mode.value !== "all"; }
  mode.addEventListener("change", updateMode); updateMode();
  group.append(field("Signing event kind access", mode, "secret-kind-mode"), warning, selected);
  return { node: group, value() {
    const overrides = JSON.parse(rules.value || "[]");
    if (!Array.isArray(overrides)) throw new Error("Signing rules must be a JSON array");
    const extra = custom.value.trim() ? custom.value.split(",").map(value => value.trim()) : [];
    if (extra.some(value => !/^\d+$/.test(value) || Number(value) > 65535)) throw new Error("Kinds must be integers from 0 to 65535");
    return { kindMode: mode.value, kindRules: [...new Set([...chosen.values(), ...extra].map(Number))].map(kind => overrides.find(rule => rule.kind === kind) || {
      kind, maxContentBytes: 8192, maxTags: 16, maxTagBytes: 4096,
      allowedTagNames: ["e", "p", "t", "r", "d", "title", "summary", "image", "published_at"],
    }) };
  } };
}

